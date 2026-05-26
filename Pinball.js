/* ============================================================================
 * PINBALL BUDDY — Pinball.js
 * v0.004    — full physics rebuild
 * v0.004.1  — lane-feed arc, top-right hood redesign, flipper-gap drain fix
 *
 * Single-file ES module. Exports openPinball().
 *
 *   import { openPinball } from './Pinball.js';
 *   openPinball('worm_holer');                      // standalone
 *   openPinball('worm_holer', state, data, api);    // from SPACED
 *
 * ARCHITECTURE (read before editing)
 * ----------------------------------
 *  - The world is a list of COLLIDERS. Every collider is either a SEGMENT
 *    (line, with circular end-caps so corners are smooth) or a CIRCLE
 *    (bumpers, posts). Targets, walls, slingshots, flipper bodies — all
 *    segments. There is exactly ONE source of truth for collision shape,
 *    and the renderer draws THAT SAME LIST. They cannot drift apart.
 *
 *  - Collision is CONTINUOUS (swept). Each frame the ball's motion is
 *    integrated in sub-steps; within a sub-step we find the earliest
 *    time-of-impact against every collider, advance exactly to it,
 *    reflect the velocity, and continue with the remaining time. A fast
 *    ball physically cannot tunnel through a thin wall or target.
 *
 *  - Resolution is SINGLE-PASS per sub-step (earliest hit wins), which is
 *    what kills the infinite ping-pong: the ball is never shoved by object
 *    A into object B and back. Post-resolution a tiny separation epsilon
 *    pushes the ball off the surface so it can't re-trigger the same hit.
 *
 *  - Z-AXIS. The ball has z / vz. Ramps are regions with a floor-height
 *    function. While the ball is on a ramp it rides the ramp rails only
 *    and ignores playfield-level colliders. The renderer scales the ball
 *    and offsets its shadow by z, so elevation is unmistakable.
 *
 *  - The DMD (dot-matrix display) is independent of physics. It is the
 *    same system as before: always-on, score / messages / mode flashes.
 * ========================================================================== */

/* ==========================================================================
 * SECTION 1 — MATH
 * ========================================================================== */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
const dist  = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

// vector helpers (plain {x,y})
const vlen  = v => Math.hypot(v.x, v.y);
const vnorm = v => { const l = vlen(v) || 1; return { x: v.x / l, y: v.y / l }; };
const vdot  = (a, b) => a.x * b.x + a.y * b.y;
const vsub  = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const vadd  = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const vmul  = (a, s) => ({ x: a.x * s, y: a.y * s });

// closest point on segment AB to point P -> {x,y,t}
function closestOnSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby || 1e-9;
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = clamp(t, 0, 1);
  return { x: ax + abx * t, y: ay + aby * t, t };
}

/* ==========================================================================
 * SECTION 2 — TABLE CONSTANTS
 * ========================================================================== */
const PB = {
  W: 540, H: 960,           // playfield canvas px
  BALL_R: 10,               // ball radius
  GRAVITY: 0.34,            // px/frame^2 downward
  MAX_SPEED: 26,            // velocity clamp (prevents runaway)
  SUBSTEPS: 6,              // collision sub-steps per frame
  RESTITUTION: 0.36,        // generic wall bounciness
  FRICTION: 0.992,          // per-frame velocity retention (rolling drag)
  SEP_EPS: 0.6,             // separation pushed out after a contact
  DMD_W: 540, DMD_H: 132,   // dot-matrix display canvas px
};

// playfield bounding walls (used by every table)
const WALL = { L: 26, R: 514, T: 26, DRAIN_Y: 944 };

export const PB_VERSION = 'v0.004.1';

/* ==========================================================================
 * SECTION 3 — COLLIDER PRIMITIVES
 * --------------------------------------------------------------------------
 * Colliders are plain data. Physics consumes them; the renderer draws them.
 * kind: 'seg'  -> a,b endpoints, r = edge thickness radius
 *       'circle' -> c center, r radius
 * Shared optional fields:
 *   bounce   : restitution override (else PB.RESTITUTION)
 *   role     : 'wall' | 'target' | 'bumper' | 'sling' | 'flipper' | 'post' | 'ramp'
 *   ref      : back-pointer to the game object (target/bumper) for scoring
 *   active   : if false the collider is skipped this frame (used by gates)
 * ========================================================================== */
function seg(ax, ay, bx, by, opt = {}) {
  return {
    kind: 'seg', a: { x: ax, y: ay }, b: { x: bx, y: by },
    r: opt.r ?? 2, bounce: opt.bounce ?? PB.RESTITUTION,
    role: opt.role ?? 'wall', ref: opt.ref ?? null, active: opt.active ?? true,
    color: opt.color ?? null,
  };
}
function circle(cx, cy, r, opt = {}) {
  return {
    kind: 'circle', c: { x: cx, y: cy }, r,
    bounce: opt.bounce ?? PB.RESTITUTION,
    role: opt.role ?? 'wall', ref: opt.ref ?? null, active: opt.active ?? true,
    color: opt.color ?? null,
  };
}

/* ==========================================================================
 * SECTION 4 — SWEPT COLLISION
 * --------------------------------------------------------------------------
 * sweepCircleVsCollider(p0, vel, R, col)
 *   p0  : ball center at start of sub-step {x,y}
 *   vel : displacement vector for this sub-step {x,y}
 *   R   : ball radius
 *   col : collider
 *   -> null, or { t, nx, ny, point } where
 *        t      = fraction [0,1] of vel at which contact occurs
 *        nx,ny  = unit surface normal pointing AT the ball
 *        point  = world contact point on the collider surface
 *
 * SEGMENT case: a moving circle vs a segment-with-radius is equivalent to a
 * moving point vs a capsule of radius (R + col.r). We test the swept point
 * against the capsule: the two end discs and the slab between them.
 * CIRCLE case: classic moving-circle vs static-circle quadratic.
 * ========================================================================== */
function sweepVsCircle(p0, vel, R, cx, cy, cr) {
  // moving point p0 + vel*t vs static circle radius (R+cr)
  const rad = R + cr;
  const ox = p0.x - cx, oy = p0.y - cy;
  const a = vel.x * vel.x + vel.y * vel.y;
  if (a < 1e-12) {
    // not moving — handle as static overlap (resolved elsewhere)
    return null;
  }
  const b = 2 * (ox * vel.x + oy * vel.y);
  const c = ox * ox + oy * oy - rad * rad;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a); // started inside; take exit-ish root
  if (t < -0.001 || t > 1) return null;
  t = clamp(t, 0, 1);
  const hx = p0.x + vel.x * t, hy = p0.y + vel.y * t;
  let nx = hx - cx, ny = hy - cy;
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl; ny /= nl;
  return { t, nx, ny, point: { x: cx + nx * cr, y: cy + ny * cr } };
}

function sweepCircleVsCollider(p0, vel, R, col) {
  if (!col.active) return null;
  if (col.kind === 'circle') {
    return sweepVsCircle(p0, vel, R, col.c.x, col.c.y, col.r);
  }
  // SEGMENT capsule: radius = R + col.r
  const rad = R + col.r;
  const ax = col.a.x, ay = col.a.y, bx = col.b.x, by = col.b.y;
  const abx = bx - ax, aby = by - ay;
  const abLen2 = abx * abx + aby * aby || 1e-9;

  // 1) infinite-line slab test: does the swept point cross within rad of line?
  // perpendicular unit
  const segLen = Math.sqrt(abLen2);
  let nx = -aby / segLen, ny = abx / segLen;
  // make normal point toward ball start
  const side = (p0.x - ax) * nx + (p0.y - ay) * ny;
  if (side < 0) { nx = -nx; ny = -ny; }
  const sd0 = (p0.x - ax) * nx + (p0.y - ay) * ny;          // signed dist now
  const vn  = vel.x * nx + vel.y * ny;                       // normal speed
  let tLine = null;
  if (sd0 >= 0) {
    if (vn < -1e-9) {
      const tt = (sd0 - rad) / -vn;
      if (tt <= 1) tLine = Math.max(0, tt);
    } else if (sd0 <= rad) {
      tLine = 0; // already within slab, moving along/away — treat as touching
    }
  }
  let best = null;
  if (tLine !== null) {
    const hx = p0.x + vel.x * tLine, hy = p0.y + vel.y * tLine;
    // projection onto segment
    let proj = ((hx - ax) * abx + (hy - ay) * aby) / abLen2;
    if (proj >= 0 && proj <= 1) {
      const cpx = ax + abx * proj, cpy = ay + aby * proj;
      best = { t: tLine, nx, ny, point: { x: cpx, y: cpy } };
    }
  }
  // 2) end-cap discs (handles corners + the segment ends)
  const capA = sweepVsCircle(p0, vel, R, ax, ay, col.r);
  const capB = sweepVsCircle(p0, vel, R, bx, by, col.r);
  for (const cap of [capA, capB]) {
    if (cap && (!best || cap.t < best.t)) best = cap;
  }
  return best;
}

/* static depenetration: if ball is already overlapping a collider, push out.
 * returns {nx,ny,depth} or null. Used as a safety net so the ball never
 * settles inside geometry (which would otherwise cause sticking). */
function staticPush(p, R, col) {
  if (!col.active) return null;
  if (col.kind === 'circle') {
    const d = dist(p.x, p.y, col.c.x, col.c.y);
    const rad = R + col.r;
    if (d < rad - 0.01) {
      let nx = (p.x - col.c.x), ny = (p.y - col.c.y);
      const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      return { nx, ny, depth: rad - d };
    }
    return null;
  }
  const cp = closestOnSeg(p.x, p.y, col.a.x, col.a.y, col.b.x, col.b.y);
  const d = dist(p.x, p.y, cp.x, cp.y);
  const rad = R + col.r;
  if (d < rad - 0.01) {
    let nx = p.x - cp.x, ny = p.y - cp.y;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    return { nx, ny, depth: rad - d };
  }
  return null;
}

/* ==========================================================================
 * SECTION 5 — MODULE STATE
 * ========================================================================== */
const _keys = { left: false, right: false, space: false };
let _ov = null;            // overlay root
let _raf = 0;              // requestAnimationFrame id
let _ac = null;            // AudioContext
let _running = false;
let _table = null;         // active built table (geometry + logic)
let _tdef = null;          // table metadata from JSON
let _pb = {};              // mutable game state (freshPB)
let _spaced = null;        // { state, data, api } when launched from SPACED
let _pfCanvas = null, _pfCtx = null;
let _dmdCanvas = null, _dmdCtx = null;
let _lastT = 0;

function freshPB() {
  return {
    phase: 'attract',      // attract | plunge | play | balllost | gameover
    score: 0,
    ball: 1,
    ballsTotal: 3,
    mult: 1,
    combo: 0,
    comboTimer: 0,
    balls: [],             // live Ball objects (multiball)
    plungeCharge: 0,       // 0..1
    plungePower: 0,        // captured on release
    flipper: { lU: 0, lA: 0, rU: 0, rA: 0 }, // current/target angles per flipper group
    dmd: { mode: 'attract', msg: '', sub: '', timer: 0, t: 0 },
    modeName: '',
    modeTimer: 0,
    tick: 0,
    shake: 0,
    started: false,
    highScore: 0,
  };
}

/* a single ball */
function Ball(x, y) {
  return {
    x, y, vx: 0, vy: 0,
    z: 0, vz: 0,          // elevation
    r: PB.BALL_R,
    onRamp: null,         // ramp object the ball is currently riding, or null
    rampT: 0,             // 0..1 progress along current ramp
    dead: false,
    inLane: true,         // sitting in the plunger lane
    laneFeed: false,      // running the scripted lane-mouth feed arc
    feedT: 0,             // progress along the feed arc (0..1)
    feedSpeed: 9,         // speed carried through the feed arc
    stuckTimer: 0,        // anti-stuck watchdog
    lastSpeed: 0,
    trail: [],
  };
}

/* ==========================================================================
 * SECTION 6 — AUDIO (synth, no asset files)
 * ========================================================================== */
function initAudio() {
  try { _ac = new (window.AudioContext || window.webkitAudioContext)(); }
  catch (e) { _ac = null; }
}
function resumeAudio() { if (_ac && _ac.state === 'suspended') _ac.resume(); }

function tone(freq, dur, type = 'sine', vol = 0.18, slideTo = null) {
  if (!_ac) return;
  const o = _ac.createOscillator();
  const g = _ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, _ac.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), _ac.currentTime + dur);
  g.gain.setValueAtTime(vol, _ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + dur);
  o.connect(g); g.connect(_ac.destination);
  o.start(); o.stop(_ac.currentTime + dur + 0.02);
}
function noise(dur, vol = 0.15, freq = 1200) {
  if (!_ac) return;
  const n = Math.floor(_ac.sampleRate * dur);
  const buf = _ac.createBuffer(1, n, _ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = _ac.createBufferSource(); s.buffer = buf;
  const f = _ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq;
  const g = _ac.createGain(); g.gain.value = vol;
  g.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + dur);
  s.connect(f); f.connect(g); g.connect(_ac.destination);
  s.start(); s.stop(_ac.currentTime + dur + 0.02);
}
function snd(name) {
  switch (name) {
    case 'flipper':  tone(180, 0.06, 'square', 0.10); break;
    case 'bumper':   tone(440, 0.10, 'triangle', 0.18, 700); break;
    case 'sling':    tone(330, 0.08, 'sawtooth', 0.14, 520); break;
    case 'target':   tone(660, 0.07, 'square', 0.12, 880); break;
    case 'wall':     tone(150, 0.04, 'sine', 0.06); break;
    case 'ramp':     tone(520, 0.18, 'sine', 0.12, 900); break;
    case 'rampDown': tone(700, 0.16, 'sine', 0.10, 380); break;
    case 'drain':    tone(200, 0.5, 'sawtooth', 0.16, 60); break;
    case 'launch':   tone(120, 0.3, 'sawtooth', 0.18, 420); break;
    case 'group':    [523,659,784,1046].forEach((f,i)=>setTimeout(()=>tone(f,0.16,'square',0.14),i*70)); break;
    case 'wormhole': tone(880, 0.4, 'sine', 0.16, 110); noise(0.4, 0.10, 600); break;
    case 'wormActivate': [220,330,440,660].forEach((f,i)=>setTimeout(()=>tone(f,0.2,'triangle',0.14),i*60)); break;
    case 'multiball':[392,523,659,784,1046].forEach((f,i)=>setTimeout(()=>tone(f,0.22,'square',0.16),i*90)); break;
    case 'mode':     [330,440,550].forEach((f,i)=>setTimeout(()=>tone(f,0.25,'triangle',0.16),i*100)); break;
    case 'lock':     tone(294, 0.2, 'sine', 0.14, 180); break;
    case 'gameover': [440,392,349,294,247].forEach((f,i)=>setTimeout(()=>tone(f,0.4,'sawtooth',0.16),i*220)); break;
    default: break;
  }
}

/* ==========================================================================
 * SECTION 7 — DMD (dot-matrix display)
 * --------------------------------------------------------------------------
 * Unchanged in spirit from prior versions: a virtual low-res dot grid drawn
 * onto a real canvas. Always visible. dmd(msg,sub) flashes a message.
 * Future: per-table animated attract sequences plug into drawDMD().
 * ========================================================================== */
const DMD = { cols: 108, rows: 26, dot: 5 }; // virtual grid

function dmdFlash(msg, sub = '') {
  _pb.dmd.msg = msg; _pb.dmd.sub = sub;
  _pb.dmd.timer = 150;  // ~2.5s at 60fps
}

// tiny 5x7-ish pixel font (uppercase, digits, basic punctuation)
const GLYPHS = (() => {
  // each glyph is 5 wide x 7 tall, rows top->bottom, bits left->right
  const F = {
    'A':['01110','10001','10001','11111','10001','10001','10001'],
    'B':['11110','10001','11110','10001','10001','10001','11110'],
    'C':['01110','10001','10000','10000','10000','10001','01110'],
    'D':['11110','10001','10001','10001','10001','10001','11110'],
    'E':['11111','10000','11110','10000','10000','10000','11111'],
    'F':['11111','10000','11110','10000','10000','10000','10000'],
    'G':['01110','10001','10000','10111','10001','10001','01111'],
    'H':['10001','10001','10001','11111','10001','10001','10001'],
    'I':['11111','00100','00100','00100','00100','00100','11111'],
    'J':['00111','00010','00010','00010','10010','10010','01100'],
    'K':['10001','10010','10100','11000','10100','10010','10001'],
    'L':['10000','10000','10000','10000','10000','10000','11111'],
    'M':['10001','11011','10101','10101','10001','10001','10001'],
    'N':['10001','11001','10101','10011','10001','10001','10001'],
    'O':['01110','10001','10001','10001','10001','10001','01110'],
    'P':['11110','10001','10001','11110','10000','10000','10000'],
    'Q':['01110','10001','10001','10001','10101','10010','01101'],
    'R':['11110','10001','10001','11110','10100','10010','10001'],
    'S':['01111','10000','10000','01110','00001','00001','11110'],
    'T':['11111','00100','00100','00100','00100','00100','00100'],
    'U':['10001','10001','10001','10001','10001','10001','01110'],
    'V':['10001','10001','10001','10001','10001','01010','00100'],
    'W':['10001','10001','10001','10101','10101','11011','10001'],
    'X':['10001','10001','01010','00100','01010','10001','10001'],
    'Y':['10001','10001','01010','00100','00100','00100','00100'],
    'Z':['11111','00010','00100','01000','10000','10000','11111'],
    '0':['01110','10011','10101','10101','11001','10001','01110'],
    '1':['00100','01100','00100','00100','00100','00100','01110'],
    '2':['01110','10001','00001','00110','01000','10000','11111'],
    '3':['11110','00001','00001','01110','00001','00001','11110'],
    '4':['00010','00110','01010','10010','11111','00010','00010'],
    '5':['11111','10000','11110','00001','00001','10001','01110'],
    '6':['00110','01000','10000','11110','10001','10001','01110'],
    '7':['11111','00001','00010','00100','01000','01000','01000'],
    '8':['01110','10001','10001','01110','10001','10001','01110'],
    '9':['01110','10001','10001','01111','00001','00010','01100'],
    ' ':['00000','00000','00000','00000','00000','00000','00000'],
    '.':['00000','00000','00000','00000','00000','01100','01100'],
    ',':['00000','00000','00000','00000','00000','00110','01100'],
    '!':['00100','00100','00100','00100','00100','00000','00100'],
    '?':['01110','10001','00010','00100','00100','00000','00100'],
    ':':['00000','01100','01100','00000','01100','01100','00000'],
    '-':['00000','00000','00000','11111','00000','00000','00000'],
    "'":['00100','00100','00100','00000','00000','00000','00000'],
    '+':['00000','00100','00100','11111','00100','00100','00000'],
    'x':['00000','00000','10001','01010','00100','01010','10001'],
    '/':['00001','00010','00100','00100','01000','10000','10000'],
  };
  return F;
})();

function dmdText(grid, str, x, y, on = 1) {
  str = String(str).toUpperCase();
  let cx = x;
  for (const ch of str) {
    const g = GLYPHS[ch] || GLYPHS['?'];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r][c] === '1') {
          const gx = cx + c, gy = y + r;
          if (gx >= 0 && gx < DMD.cols && gy >= 0 && gy < DMD.rows) grid[gy][gx] = on;
        }
      }
    }
    cx += 6;
  }
  return cx;
}
function dmdTextCentered(grid, str, y, on = 1) {
  const w = String(str).length * 6 - 1;
  dmdText(grid, str, Math.floor((DMD.cols - w) / 2), y, on);
}

/* ==========================================================================
 * (engine continues in part 2 — geometry builders, table, physics step,
 *  render, UI — appended below)
 * ========================================================================== */

/* ==========================================================================
 * SECTION 8 — FLIPPER MODEL
 * --------------------------------------------------------------------------
 * A flipper is a fat segment that rotates about a pivot between a rest angle
 * and an active angle. Its collider is rebuilt every frame from the current
 * angle, so the thing you SEE is the thing you HIT.
 *
 * Canvas y increases DOWNWARD. We store angles in standard math convention
 * and just accept that. restAngle/activeAngle are absolute angles of the
 * flipper's pointing direction (pivot -> tip). The flipper sweeps between
 * them; angular velocity is tracked so a moving flipper imparts momentum to
 * the ball (a real flipper "shot" — not just a static bounce).
 * ========================================================================== */
function makeFlipper(opt) {
  return {
    side: opt.side,                 // 'L' | 'R'
    group: opt.group ?? 'main',     // flippers in the same group share a key
    px: opt.px, py: opt.py,         // pivot
    len: opt.len ?? 78,
    r: opt.r ?? 9,                  // flipper thickness radius
    rest: opt.rest,                 // absolute rest angle (radians)
    active: opt.active,             // absolute active angle (radians)
    angle: opt.rest,                // current angle
    av: 0,                          // angular velocity (rad/frame)
    up: false,                      // commanded up?
    speed: opt.speed ?? 0.62,       // how fast it swings (rad/frame)
  };
}
function flipperTip(fl) {
  return { x: fl.px + Math.cos(fl.angle) * fl.len,
           y: fl.py + Math.sin(fl.angle) * fl.len };
}
function flipperCollider(fl) {
  const tip = flipperTip(fl);
  return seg(fl.px, fl.py, tip.x, tip.y, { r: fl.r, role: 'flipper', bounce: 0.5, ref: fl });
}
function updateFlipper(fl) {
  const target = fl.up ? fl.active : fl.rest;
  const prev = fl.angle;
  // move toward target, capped by swing speed
  const diff = target - fl.angle;
  const step = clamp(diff, -fl.speed, fl.speed);
  fl.angle += step;
  fl.av = fl.angle - prev;       // angular velocity this frame
}

/* ==========================================================================
 * SECTION 9 — RAMP MODEL (the Z axis)
 * --------------------------------------------------------------------------
 * A ramp is a CENTERLINE PATH (list of points) with a width, plus a height
 * profile h0..h1 (z at entry .. z at exit). Two rail colliders run down each
 * side of the path so the ball is physically funneled.
 *
 * When the ball's center is within the ramp's mouth zone AND moving fast
 * enough INTO the ramp, it "mounts": ball.onRamp is set, the ball follows
 * the centerline, its z is interpolated from rampT, and it ignores
 * playfield-level colliders. At rampT>=1 it ejects at the exit with the
 * exit direction + a speed boost; at rampT<=0 (rolled back) it dismounts at
 * the entry. The renderer scales the ball by z and offsets the shadow, so
 * "this ball is up on a ramp" is visually obvious.
 * ========================================================================== */
function makeRamp(opt) {
  // opt.path: [{x,y}...] centerline from entry to exit
  // opt.width, opt.h0, opt.h1, opt.exitBoost, opt.id, opt.color
  const path = opt.path;
  // cumulative length for arc-length parametrization
  const segLens = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i-1].x, path[i-1].y, path[i].x, path[i].y);
    segLens.push(d); total += d;
  }
  return {
    id: opt.id, path, segLens, total,
    width: opt.width ?? 30,
    h0: opt.h0 ?? 0, h1: opt.h1 ?? 60,
    exitBoost: opt.exitBoost ?? 9,
    mountSpeed: opt.mountSpeed ?? 6,   // min speed into mouth to mount
    color: opt.color ?? '#39d7ff',
    onEject: opt.onEject ?? null,
  };
}
// point + tangent at arc fraction t (0..1)
function rampPoint(ramp, t) {
  t = clamp(t, 0, 1);
  let target = t * ramp.total, acc = 0;
  for (let i = 0; i < ramp.segLens.length; i++) {
    if (acc + ramp.segLens[i] >= target || i === ramp.segLens.length - 1) {
      const local = ramp.segLens[i] < 1e-6 ? 0 : (target - acc) / ramp.segLens[i];
      const p0 = ramp.path[i], p1 = ramp.path[i+1];
      const x = lerp(p0.x, p1.x, local), y = lerp(p0.y, p1.y, local);
      let tx = p1.x - p0.x, ty = p1.y - p0.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      return { x, y, tx, ty };
    }
    acc += ramp.segLens[i];
  }
  const p = ramp.path[ramp.path.length - 1];
  return { x: p.x, y: p.y, tx: 0, ty: -1 };
}
function rampHeight(ramp, t) { return lerp(ramp.h0, ramp.h1, clamp(t, 0, 1)); }

/* ==========================================================================
 * SECTION 10 — TABLE: WORM HOLER
 * --------------------------------------------------------------------------
 * A genuine pinball layout. Coordinates chosen for a 540x960 playfield.
 *
 * Lower third  : two main flippers in a proper triangle, slingshots above
 *                them, inlane/outlane guides, return lanes.
 * Mid third    : pop-bumper cluster (fan-spaced 92px apart), drop-target
 *                bank "WORM", a mid-table flipper pair (kickers).
 * Upper third  : drop-target bank "HOLE", two orbit lanes, ramp habitrails.
 * Worm holes   : 4 circular sink-holes; activate sequentially; an active
 *                hole exerts a gentle gravity pull and teleports the ball
 *                to a random other active hole.
 *
 * Everything pushes into ONE colliders[] array each frame (rebuilt because
 * flippers move). Static geometry is cached and flipper/dynamic colliders
 * are appended.
 * ========================================================================== */
function buildWormHoler(tdef) {
  const T = {
    id: 'worm_holer',
    name: tdef?.name || 'WORM HOLER',
    colors: tdef?.colors || { bg:'#0a0a1f', mid:'#1a1145', neon:'#ff3ea5',
                              neon2:'#39d7ff', wall:'#5b4b9e' },
    staticColliders: [],
    flippers: [],
    bumpers: [],
    targets: [],
    ramps: [],
    wormholes: [],
    posts: [],
    lanes: [],          // rollover lanes (top)
    spinners: [],
    lockZone: null,
    // logic state
    wormProgress: 0,    // letters of WORM hit
    holeProgress: 0,    // letters of HOLE hit
    activeHoles: 0,
    locked: 0,
    multiballArmed: false,
  };

  /* ---- outer walls (the boundary of play) ---- */
  const W = WALL;
  // left & right walls, angled top corners, leaving a plunger lane on the right
  const laneX = PB.W - 46;          // plunger lane centre
  const laneWallL = PB.W - 70;      // inner wall of plunger lane
  // The plunger lane occupies the right edge. Its INNER wall runs from the
  // table floor up to laneTop; above laneTop the lane OPENS so the ball can
  // arc left into the playfield. A curved deflector along the top-right
  // sweeps the ball leftward.
  const laneTop = 210;          // y where the lane opens into the field
  // TOP-RIGHT DESIGN (classic feed): the plunger lane is a sealed channel
  // from the floor up to the lane mouth at laneTop. At the mouth the inner
  // wall ENDS and a short angled "kicker lip" juts in from the right wall,
  // so a ball rising out of the lane is deflected LEFT into the field. The
  // continuous hood above prevents the ball escaping over the top-right.
  // main field outer walls
  T.staticColliders.push(
    seg(W.L, W.T+60, W.L, 720, { r:4, role:'wall', color:T.colors.wall }),       // left wall
    seg(W.L, W.T+60, 150, W.T, { r:4, role:'wall', color:T.colors.wall }),       // top-left diagonal
    seg(150, W.T, 360, W.T, { r:4, role:'wall', color:T.colors.wall }),          // top wall
    // ---- deflector hood (continuous, sweeps the ball left, no flat shelf) ----
    seg(360, W.T, 440, 46, { r:5, role:'wall', color:T.colors.wall }),           // hood: top wall -> right shoulder
    seg(440, 46, 488, 120, { r:5, role:'wall', color:T.colors.wall }),           // hood: shoulder -> outer crest
    seg(488, 120, 470, 196, { r:5, role:'wall', color:T.colors.wall }),          // hood: crest curving back inward to mouth
    // hood underside: a long DOWN-LEFT ramp that carries the ball into play
    seg(470, 196, 372, 250, { r:5, role:'wall', color:T.colors.wall }),
    // inner plunger-lane wall: floor up to the lane mouth ONLY
    seg(laneWallL, laneTop, laneWallL, 900, { r:4, role:'wall', color:T.colors.wall }),
    // kicker lip at the mouth: short angled stub from the right wall that
    // noses the rising ball left so it always clears onto the hood underside
    seg(W.R, laneTop-4, laneWallL+6, laneTop-30, { r:4, role:'wall', color:T.colors.wall }),
    seg(W.R, W.T+30, W.R, 900, { r:4, role:'wall', color:T.colors.wall }),       // far right wall
  );

  /* ---- plunger lane ---- */
  T.plunger = {
    x: laneX, top: laneTop, bottom: 900,
    laneL: laneWallL, laneR: W.R,
    headY: 880, headRest: 880, headDeep: 920,
  };
  // one-way gate sealing the lane channel at the mouth. Blocks a ball
  // FALLING back into the lane; never blocks a ball leaving. Angled so a
  // ball can never balance on top of it.
  T.laneGate = seg(laneWallL, laneTop+8, W.R, laneTop-8, { r:3, role:'gate', active:false });

  /* ---- lower flippers (proper triangle) ----
   * Pivots 150px apart, tips ~ 1 ball-width apart, raked ~28deg.
   * Rest: tip angled DOWN-and-out. Active: swung UP-and-in. */
  const flY = 812;
  const restRake = 0.50;       // radians below horizontal at rest
  const swing    = 0.95;       // total swing
  T.flippers.push(
    makeFlipper({ side:'L', group:'main', px:176, py:flY, len:84,
      rest:  restRake,                 // points down-right
      active: restRake - swing }),     // swings up
    makeFlipper({ side:'R', group:'main', px:364, py:flY, len:84,
      rest:  Math.PI - restRake,       // points down-left
      active: Math.PI - restRake + swing }),
  );

  /* ---- slingshots (the angled bumpers above each flipper) ---- */
  // left sling
  T.staticColliders.push(
    seg(96, 690, 150, 790, { r:7, role:'sling', bounce:1.05, color:T.colors.neon }),
  );
  // right sling
  T.staticColliders.push(
    seg(444, 690, 390, 790, { r:7, role:'sling', bounce:1.05, color:T.colors.neon }),
  );
  // inlane / outlane guide rails
  T.staticColliders.push(
    seg(96, 690, 96, 760, { r:4, role:'wall', color:T.colors.wall }),     // left outer guide
    seg(150, 790, 176, 812, { r:4, role:'wall', color:T.colors.wall }),   // left inlane to flipper
    seg(444, 690, 444, 760, { r:4, role:'wall', color:T.colors.wall }),   // right outer guide
    seg(390, 790, 364, 812, { r:4, role:'wall', color:T.colors.wall }),   // right inlane to flipper
    // outlane drain channels (narrow — punishing, like real tables)
    seg(W.L, 720, 70, 820, { r:4, role:'wall', color:T.colors.wall }),
    seg(W.R, 760, 470, 850, { r:4, role:'wall', color:T.colors.wall }),
  );
  // slingshot kicker posts (small circles at sling ends so ball doesn't snag)
  T.posts.push(
    circle(96, 690, 8, { role:'post', color:T.colors.wall }),
    circle(444, 690, 8, { role:'post', color:T.colors.wall }),
  );

  /* ---- pop bumpers (fan cluster, mid-table, 96px+ apart) ---- */
  const bumperDefs = [
    { x: 200, y: 392, r: 26 },
    { x: 320, y: 392, r: 26 },
    { x: 260, y: 300, r: 26 },
  ];
  for (const bd of bumperDefs) {
    const b = { x: bd.x, y: bd.y, r: bd.r, cooldown: 0, flash: 0, value: 250 };
    T.bumpers.push(b);
  }

  /* ---- drop-target bank: WORM (4 targets, left mid) ---- */
  const wormBank = makeTargetBank({
    word: 'WORM', x: 78, y: 470, dx: 0, dy: 40, w: 30, h: 30,
    vertical: true, group: 'worm', value: 500,
  });
  T.targets.push(...wormBank);

  /* ---- drop-target bank: HOLE (4 targets, upper centre) ---- */
  const holeBank = makeTargetBank({
    word: 'HOLE', x: 196, y: 150, dx: 40, dy: 0, w: 30, h: 30,
    vertical: false, group: 'hole', value: 500,
  });
  T.targets.push(...holeBank);

  /* ---- worm holes (4 sink-holes) ---- */
  const holeSpots = [
    { x: 120, y: 250 }, { x: 420, y: 250 },
    { x: 130, y: 560 }, { x: 410, y: 560 },
  ];
  holeSpots.forEach((s, i) => {
    T.wormholes.push({
      x: s.x, y: s.y, r: 22, active: false, idx: i,
      pull: 0.10, swirl: 0,
    });
  });

  /* ---- mid-table mini flippers (kickers near the bumper cluster) ---- */
  T.flippers.push(
    makeFlipper({ side:'L', group:'mid', px:150, py:540, len:54, r:8,
      rest: 0.45, active: 0.45 - 0.85, speed: 0.7 }),
    makeFlipper({ side:'R', group:'mid', px:390, py:540, len:54, r:8,
      rest: Math.PI - 0.45, active: Math.PI - 0.45 + 0.85, speed: 0.7 }),
  );

  /* ---- ramps (real Z-axis habitrails) ---- */
  // LEFT ORBIT RAMP: enters near left sling area, climbs, loops over the top,
  // ejects down the right inlane.
  T.ramps.push(makeRamp({
    id: 'left_orbit',
    path: [
      { x: 110, y: 640 }, { x: 86, y: 520 }, { x: 96, y: 360 },
      { x: 150, y: 200 }, { x: 270, y: 120 }, { x: 392, y: 150 },
      { x: 430, y: 300 }, { x: 430, y: 470 }, { x: 420, y: 640 },
    ],
    width: 30, h0: 0, h1: 70, exitBoost: 7, mountSpeed: 7,
    color: T.colors.neon2,
  }));
  // CENTER LOOP RAMP: short ramp up the middle that re-feeds the bumpers.
  T.ramps.push(makeRamp({
    id: 'center_loop',
    path: [
      { x: 260, y: 540 }, { x: 260, y: 460 }, { x: 230, y: 420 },
      { x: 260, y: 360 }, { x: 300, y: 340 },
    ],
    width: 28, h0: 0, h1: 48, exitBoost: 6, mountSpeed: 6.5,
    color: T.colors.neon,
  }));

  /* ---- ball lock (center sink, triggers multiball) ---- */
  T.lockZone = { x: 260, y: 220, r: 20, active: true };

  /* ---- top rollover lanes (skill-shot style) ---- */
  T.lanes.push(
    { x: 175, y: 86, lit: false }, { x: 270, y: 78, lit: false }, { x: 365, y: 86, lit: false },
  );

  return T;
}

/* build a bank of drop targets spelling a word */
function makeTargetBank(opt) {
  const arr = [];
  for (let i = 0; i < opt.word.length; i++) {
    arr.push({
      letter: opt.word[i],
      group: opt.group,
      x: opt.x + opt.dx * i,
      y: opt.y + opt.dy * i,
      w: opt.w, h: opt.h,
      vertical: opt.vertical,
      hit: false,
      flash: 0,
      value: opt.value,
      idx: i,
    });
  }
  return arr;
}


/* ==========================================================================
 * SECTION 11 — COLLIDER ASSEMBLY
 * --------------------------------------------------------------------------
 * Each physics frame we build the full collider list: cached static walls,
 * + dynamic flipper colliders, + bumper circles, + target segments, + posts,
 * + ramp side-rails (only when relevant). This single list is what BOTH the
 * physics and the renderer use.
 * ========================================================================== */
function targetCollider(t) {
  // a drop target is a fat segment across its face; ALWAYS SOLID regardless
  // of t.hit. t.hit only changes color. (This was a major historical bug.)
  if (t.vertical) {
    // vertical bank: face is a vertical-ish segment
    return seg(t.x, t.y - t.h/2, t.x, t.y + t.h/2,
      { r: t.w/2, role:'target', bounce:0.9, ref:t });
  }
  return seg(t.x - t.w/2, t.y, t.x + t.w/2, t.y,
    { r: t.h/2, role:'target', bounce:0.9, ref:t });
}
function bumperCollider(b) {
  return circle(b.x, b.y, b.r, { role:'bumper', bounce:1.0, ref:b });
}
function rampRailColliders(ramp) {
  // build left/right rail segments offset from centerline
  const rails = [];
  const hw = ramp.width / 2;
  for (let i = 1; i < ramp.path.length; i++) {
    const p0 = ramp.path[i-1], p1 = ramp.path[i];
    let nx = -(p1.y - p0.y), ny = (p1.x - p0.x);
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    rails.push(seg(p0.x+nx*hw, p0.y+ny*hw, p1.x+nx*hw, p1.y+ny*hw,
      { r:3, role:'ramprail', bounce:0.4, color:ramp.color }));
    rails.push(seg(p0.x-nx*hw, p0.y-ny*hw, p1.x-nx*hw, p1.y-ny*hw,
      { r:3, role:'ramprail', bounce:0.4, color:ramp.color }));
  }
  return rails;
}

function assembleColliders(T) {
  const list = [];
  // static walls / slings / posts
  for (const c of T.staticColliders) list.push(c);
  for (const p of T.posts) list.push(p);
  // lane gate (one-way, toggled active when a ball is leaving the lane)
  if (T.laneGate) list.push(T.laneGate);
  // flippers (rebuilt from current angle)
  for (const fl of T.flippers) list.push(flipperCollider(fl));
  // bumpers
  for (const b of T.bumpers) list.push(bumperCollider(b));
  // targets — ALWAYS solid
  for (const t of T.targets) list.push(targetCollider(t));
  return list;
}

/* ==========================================================================
 * SECTION 12 — RAMP MOUNT / RIDE
 * --------------------------------------------------------------------------
 * mountCheck: if a ground-level ball is at a ramp mouth moving fast enough
 * into it, attach it. rideRamp: advance a mounted ball along the centerline.
 * ========================================================================== */
function tryMountRamp(ball, T) {
  if (ball.onRamp || ball.inLane) return;
  for (const ramp of T.ramps) {
    const entry = ramp.path[0];
    const d = dist(ball.x, ball.y, entry.x, entry.y);
    if (d > ramp.width * 0.9) continue;
    // direction the ramp goes at entry
    const rp = rampPoint(ramp, 0.02);
    const into = (ball.vx * rp.tx + ball.vy * rp.ty);
    const speed = Math.hypot(ball.vx, ball.vy);
    if (into > 0 && speed >= ramp.mountSpeed) {
      ball.onRamp = ramp;
      ball.rampT = 0;
      ball.rampSpeed = speed;          // scalar speed along ramp
      snd('ramp');
      return;
    }
  }
}
function rideRamp(ball) {
  const ramp = ball.onRamp;
  if (!ramp) return;
  // gravity along a ramp: climbing costs speed, descending gains it.
  // height delta drives a speed change.
  const slope = (ramp.h1 - ramp.h0) / Math.max(1, ramp.total);
  // moving up the ramp (increasing t) against slope -> decel
  ball.rampSpeed -= slope * 0.5;          // climb drag (tuned: long orbits stay completable)
  ball.rampSpeed *= 0.998;                 // rolling friction
  if (ball.rampSpeed < 0) {
    // ball stalled — roll back down
    ball.rampSpeed = Math.max(ball.rampSpeed, -14);
  }
  const dt = ball.rampSpeed / Math.max(1, ramp.total);
  ball.rampT += dt;
  // sample position + height
  if (ball.rampT >= 1) {
    // EJECT at exit
    const rp = rampPoint(ramp, 1);
    ball.x = rp.x; ball.y = rp.y;
    ball.z = 0; ball.vz = 0;
    const ej = Math.max(ramp.exitBoost, ball.rampSpeed);
    ball.vx = rp.tx * ej; ball.vy = rp.ty * ej;
    ball.onRamp = null;
    snd('rampDown');
    if (ramp.onEject) ramp.onEject(ball);
    return;
  }
  if (ball.rampT <= 0) {
    // rolled back off the entry
    const rp = rampPoint(ramp, 0);
    ball.x = rp.x; ball.y = rp.y;
    ball.z = 0; ball.vz = 0;
    ball.vx = rp.tx * ball.rampSpeed; ball.vy = rp.ty * ball.rampSpeed;
    ball.onRamp = null;
    return;
  }
  const rp = rampPoint(ramp, ball.rampT);
  ball.x = rp.x; ball.y = rp.y;
  ball.z = rampHeight(ramp, ball.rampT);
  // store screen velocity for trail / feel
  ball.vx = rp.tx * ball.rampSpeed;
  ball.vy = rp.ty * ball.rampSpeed;
}

/* ==========================================================================
 * SECTION 13 — THE PHYSICS STEP  (per ball, per frame)
 * --------------------------------------------------------------------------
 * 1. If on a ramp, ride it (separate integrator) and return.
 * 2. Apply gravity. Clamp speed.
 * 3. Integrate motion in SUBSTEPS. Within each sub-step:
 *      a. compute remaining displacement
 *      b. sweep against ALL colliders, find earliest time-of-impact
 *      c. advance to just before impact
 *      d. reflect velocity about the surface normal, apply restitution +
 *         the special response for that collider role (bumper kick, flipper
 *         momentum transfer, target hit, etc.)
 *      e. consume the used time; repeat until time exhausted or no hit
 * 4. Static depenetration safety net.
 * 5. Worm-hole gravity + capture.
 * 6. Anti-stuck watchdog.
 * ========================================================================== */
function stepBall(ball, T, colliders) {
  if (ball.dead) return;

  /* --- on a ramp: dedicated integrator --- */
  if (ball.onRamp) {
    rideRamp(ball);
    pushTrail(ball);
    return;
  }

  /* --- lane feed arc: scripted hand-off from lane mouth into open play --- */
  if (ball.laneFeed) {
    stepLaneFeed(ball);
    pushTrail(ball);
    return;
  }

  /* --- plunger lane: ball is constrained until it leaves the lane --- */
  if (ball.inLane) {
    stepInLane(ball, T);
    pushTrail(ball);
    return;
  }

  /* --- gravity --- */
  ball.vy += PB.GRAVITY;

  /* --- worm-hole gravity pull (gentle, only active holes) --- */
  for (const wh of T.wormholes) {
    if (!wh.active) continue;
    const dx = wh.x - ball.x, dy = wh.y - ball.y;
    const d = Math.hypot(dx, dy);
    if (d < 150 && d > wh.r) {
      const f = wh.pull * (1 - d / 150);
      ball.vx += (dx / d) * f;
      ball.vy += (dy / d) * f;
    }
  }

  /* --- speed clamp --- */
  let sp = Math.hypot(ball.vx, ball.vy);
  if (sp > PB.MAX_SPEED) { const k = PB.MAX_SPEED / sp; ball.vx *= k; ball.vy *= k; sp = PB.MAX_SPEED; }
  ball.lastSpeed = sp;

  /* --- substepped swept integration --- */
  let remX = ball.vx, remY = ball.vy;     // displacement still to apply
  let safety = 0;
  while ((remX !== 0 || remY !== 0) && safety < 12) {
    safety++;
    const vel = { x: remX, y: remY };
    // find earliest hit
    let hit = null;
    for (const col of colliders) {
      // skip flippers' own pivot self etc — none needed; all valid
      const h = sweepCircleVsCollider({ x: ball.x, y: ball.y }, vel, ball.r, col);
      if (h && (!hit || h.t < hit.t)) { hit = h; hit.col = col; }
    }
    if (!hit) {
      // free flight for the rest of the displacement
      ball.x += remX; ball.y += remY;
      remX = 0; remY = 0;
      break;
    }
    // advance to just before contact
    const travel = Math.max(0, hit.t - 0.0001);
    ball.x += vel.x * travel;
    ball.y += vel.y * travel;
    // separation epsilon: nudge off the surface so we don't re-collide
    ball.x += hit.nx * PB.SEP_EPS;
    ball.y += hit.ny * PB.SEP_EPS;
    // respond to the collision (mutates ball velocity)
    respondCollision(ball, hit, T);
    // remaining displacement = leftover fraction, but recomputed from the
    // NEW (reflected) velocity so the ball continues correctly
    const leftover = 1 - hit.t;
    remX = ball.vx * leftover;
    remY = ball.vy * leftover;
  }

  /* --- friction --- */
  ball.vx *= PB.FRICTION;
  ball.vy *= PB.FRICTION;

  /* --- static depenetration safety net --- */
  for (const col of colliders) {
    const push = staticPush({ x: ball.x, y: ball.y }, ball.r, col);
    if (push) {
      ball.x += push.nx * (push.depth + PB.SEP_EPS);
      ball.y += push.ny * (push.depth + PB.SEP_EPS);
      // kill inward velocity component so it doesn't re-penetrate
      const vn = ball.vx * push.nx + ball.vy * push.ny;
      if (vn < 0) { ball.vx -= vn * push.nx; ball.vy -= vn * push.ny; }
    }
  }

  /* --- ramp mount check --- */
  tryMountRamp(ball, T);

  /* --- worm-hole capture --- */
  for (const wh of T.wormholes) {
    if (!wh.active) continue;
    if (dist(ball.x, ball.y, wh.x, wh.y) < wh.r) {
      onWormHoleEnter(ball, wh, T);
      break;
    }
  }
  /* --- ball lock capture --- */
  if (T.lockZone && T.lockZone.active &&
      dist(ball.x, ball.y, T.lockZone.x, T.lockZone.y) < T.lockZone.r) {
    onBallLock(ball, T);
  }

  /* --- top rollover lanes --- */
  for (const ln of T.lanes) {
    if (!ln.lit && Math.abs(ball.x - ln.x) < 18 && Math.abs(ball.y - ln.y) < 14) {
      ln.lit = true; addScore(150); snd('target');
      if (T.lanes.every(l => l.lit)) {
        T.lanes.forEach(l => l.lit = false);
        addScore(2500); _pb.mult++; dmdFlash('LANES COMPLETE', 'MULTIPLIER UP');
        snd('group');
      }
    }
  }

  /* --- anti-stuck watchdog --- */
  if (ball.lastSpeed < 1.2 && ball.y < WALL.DRAIN_Y - 40 && !ball.onRamp && !ball.inLane) {
    ball.stuckTimer++;
    if (ball.stuckTimer > 70 && ball.stuckTimer % 22 === 0) {
      // escalating nudge: each pulse is stronger and aimed toward open play
      const k = 1 + ball.stuckTimer / 70;
      ball.vx += (ball.x < PB.W/2 ? 2.2 : -2.2) * k;
      ball.vy += 1.6 * k;          // downward, toward the active playfield
      _pb.shake = 6;
    }
    // hard failsafe: a ball that cannot be freed after ~6s is teleported to
    // a safe spot above the flippers so play can continue.
    if (ball.stuckTimer > 360) {
      ball.x = PB.W/2; ball.y = 640;
      ball.vx = rand(-1.5, 1.5); ball.vy = 3.0; ball.z = 0; ball.vz = 0;
      ball.stuckTimer = 0;
      _pb.shake = 9;
    }
  } else {
    ball.stuckTimer = 0;
  }

  pushTrail(ball);

  /* --- drain --- */
  if (ball.y > WALL.DRAIN_Y) {
    ball.dead = true;
    snd('drain');
  }
}

function pushTrail(ball) {
  ball.trail.push({ x: ball.x, y: ball.y, z: ball.z });
  if (ball.trail.length > 9) ball.trail.shift();
}

/* --- in-lane physics: ball constrained to plunger channel --- */
function stepInLane(ball, T) {
  const pl = T.plunger;
  if (_pb.phase === 'plunge') {
    // ball rides the plunger head
    ball.x = pl.x;
    ball.y = pl.headY - ball.r - 4;
    ball.vx = 0; ball.vy = 0;
  } else {
    // ball has been launched, travelling up the lane
    ball.vy += PB.GRAVITY;
    ball.x = pl.x;             // keep centered in lane
    ball.y += ball.vy;
    // reached the lane mouth -> begin the scripted FEED arc. Rather than
    // dumping the ball into the sealed right-side channel (where it would
    // just fall straight back down), we keep it under lane control and
    // walk it left along a feed path until it is clear of the channel and
    // safely in open play, then hand it to the physics engine.
    if (ball.y <= pl.top + 4 && ball.vy < 0) {
      ball.laneFeed = true;          // enter feed-arc sub-state
      ball.feedT = 0;
      ball.feedSpeed = Math.min(Math.max(-ball.vy, 7), 15); // carry launch energy
      if (T.laneGate) T.laneGate.active = true;   // gate now blocks re-entry
    }
    // ball fell back to bottom of lane with no power -> re-seat for plunge
    if (ball.y > pl.bottom - ball.r - 10) {
      ball.y = pl.bottom - ball.r - 10;
      ball.vy = 0;
      _pb.phase = 'plunge';
      _pb.plungeCharge = 0;
    }
  }
}

/* feed arc: a short scripted path carrying the ball from the lane mouth
 * up over the hood and down-left into open play. Runs for a fixed set of
 * waypoints; on completion the ball is released to normal physics with a
 * velocity tangent to the path so the hand-off is seamless. */
const LANE_FEED_PATH = [
  { x: 494, y: 206 },   // lane mouth
  { x: 492, y: 150 },   // up past the gate
  { x: 470, y: 96  },   // over the hood crest
  { x: 430, y: 74  },   // across the top
  { x: 372, y: 96  },   // descending left
  { x: 332, y: 150 },   // into open field
  { x: 312, y: 214 },   // clear of the channel — release here
];
function stepLaneFeed(ball) {
  const path = LANE_FEED_PATH;
  // advance a normalized parameter along the polyline
  ball.feedT += (ball.feedSpeed || 9) / 240;   // ~path-length normalization
  const segs = path.length - 1;
  let t = ball.feedT * segs;
  if (t >= segs) {
    // done — release to physics with a tangent velocity (down-left)
    const a = path[segs - 1], b = path[segs];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const sp = (ball.feedSpeed || 9);
    ball.x = b.x; ball.y = b.y;
    ball.vx = (dx / L) * sp;
    ball.vy = (dy / L) * sp;
    ball.laneFeed = false;
    ball.inLane = false;
    return;
  }
  const i = Math.floor(t);
  const f = t - i;
  const a = path[i], b = path[i + 1];
  ball.x = a.x + (b.x - a.x) * f;
  ball.y = a.y + (b.y - a.y) * f;
  ball.vx = 0; ball.vy = 0;
}


/* ==========================================================================
 * SECTION 14 — COLLISION RESPONSE
 * --------------------------------------------------------------------------
 * Given a hit (normal nx,ny pointing at the ball, collider in hit.col),
 * reflect the ball's velocity and apply role-specific behavior.
 *
 * The base reflection is:  v' = v - (1+e)(v.n) n
 * For active elements (bumpers, slings, flippers) we ADD energy along the
 * normal rather than only conserving it, which is what makes pinball lively.
 * ========================================================================== */
function respondCollision(ball, hit, T) {
  const col = hit.col;
  const nx = hit.nx, ny = hit.ny;
  const vn = ball.vx * nx + ball.vy * ny;     // velocity along normal

  // one-way gate: if it's the lane gate, only block from one side
  if (col.role === 'gate') {
    // gate only solid if ball is above it moving down (re-entry block)
    if (vn < 0) {
      ball.vx -= (1 + 0.2) * vn * nx;
      ball.vy -= (1 + 0.2) * vn * ny;
    }
    return;
  }

  let e = col.bounce ?? PB.RESTITUTION;

  // base reflection (only if moving INTO the surface)
  if (vn < 0) {
    ball.vx -= (1 + e) * vn * nx;
    ball.vy -= (1 + e) * vn * ny;
  }

  switch (col.role) {
    case 'bumper': {
      const b = col.ref;
      if (b.cooldown <= 0) {
        b.cooldown = 9;          // ~150ms at 60fps
        b.flash = 12;
        // POP: add a fixed outward kick on top of the reflection
        const kick = 7.5;
        ball.vx += nx * kick;
        ball.vy += ny * kick;
        addScore(b.value * _pb.mult);
        bumpCombo();
        _pb.shake = Math.min(8, _pb.shake + 4);
        snd('bumper');
      }
      break;
    }
    case 'sling': {
      // slingshot: strong, snappy kick along the normal
      const kick = 9.0;
      ball.vx += nx * kick;
      ball.vy += ny * kick;
      addScore(120 * _pb.mult);
      _pb.shake = Math.min(7, _pb.shake + 3);
      snd('sling');
      break;
    }
    case 'flipper': {
      const fl = col.ref;
      // momentum transfer: a moving flipper imparts the surface velocity at
      // the contact point. Surface velocity = av (rad/frame) x radius arm.
      const armX = hit.point.x - fl.px;
      const armY = hit.point.y - fl.py;
      // tangential surface velocity from angular velocity (perp of arm)
      const surfVx = -armY * fl.av;
      const surfVy =  armX * fl.av;
      // add a fraction of the surface velocity into the ball
      const transfer = 1.15;
      ball.vx += surfVx * transfer;
      ball.vy += surfVy * transfer;
      // when flipper is actively swinging up and ball is near tip, give the
      // signature "live catch -> flick" punch
      if (fl.up && Math.abs(fl.av) > 0.05) {
        const armLen = Math.hypot(armX, armY) / fl.len; // 0..1 along flipper
        const punch = 4 + armLen * 5;
        ball.vx += nx * punch;
        ball.vy += ny * punch;
      }
      snd('flipper');
      break;
    }
    case 'target': {
      const t = col.ref;
      if (!t.hit) {
        t.hit = true;
        t.flash = 18;
        addScore(t.value * _pb.mult);
        bumpCombo();
        snd('target');
        onTargetHit(t, T);
      } else {
        // already-down target is STILL a solid wall — just a quieter bounce
        snd('wall');
      }
      break;
    }
    case 'ramprail':
      snd('wall');
      break;
    case 'post':
    case 'wall':
    default:
      if (Math.abs(vn) > 3) snd('wall');
      break;
  }

  // never let response leave the ball moving into the surface
  const vn2 = ball.vx * nx + ball.vy * ny;
  if (vn2 < 0) { ball.vx -= vn2 * nx; ball.vy -= vn2 * ny; }
}

/* ==========================================================================
 * SECTION 15 — SCORING & COMBO
 * ========================================================================== */
function addScore(n) { _pb.score += Math.round(n); }
function bumpCombo() {
  _pb.combo++;
  _pb.comboTimer = 90;
  if (_pb.combo > 0 && _pb.combo % 5 === 0) {
    dmdFlash(_pb.combo + 'X COMBO', '+' + (_pb.combo * 200));
    addScore(_pb.combo * 200);
    snd('group');
  }
}

/* ==========================================================================
 * SECTION 16 — WORM HOLER GAME LOGIC
 * ========================================================================== */
function onTargetHit(t, T) {
  // count completion of a bank
  const bank = T.targets.filter(x => x.group === t.group);
  const done = bank.every(x => x.hit);
  if (done) {
    if (t.group === 'worm') {
      T.wormProgress++;
      activateWormHole(T);
      dmdFlash('WORM COMPLETE', 'HOLE ' + Math.min(T.activeHoles, 4) + ' OPEN');
      addScore(3000 * _pb.mult);
    } else if (t.group === 'hole') {
      T.holeProgress++;
      activateWormHole(T);
      dmdFlash('HOLE COMPLETE', 'WORMHOLE CHARGED');
      addScore(3000 * _pb.mult);
    }
    snd('group');
    // reset the bank after a beat (drop targets pop back up)
    setTimeout(() => { bank.forEach(x => { x.hit = false; }); }, 900);
  }
}

function activateWormHole(T) {
  // turn on the next inactive worm hole
  for (const wh of T.wormholes) {
    if (!wh.active) {
      wh.active = true;
      T.activeHoles++;
      snd('wormActivate');
      break;
    }
  }
  if (T.activeHoles >= 4 && !T.multiballArmed) {
    T.multiballArmed = true;
    dmdFlash('WORMHOLES ALIGNED', 'LOCK BALL FOR MULTIBALL');
  }
}

function onWormHoleEnter(ball, wh, T) {
  // teleport ball to a random OTHER active hole
  const others = T.wormholes.filter(h => h.active && h !== wh);
  addScore(1500 * _pb.mult);
  snd('wormhole');
  _pb.shake = 8;
  if (others.length === 0) {
    // single active hole: kick the ball back out
    ball.vx = rand(-5, 5); ball.vy = -rand(6, 9);
    return;
  }
  const dest = others[randi(0, others.length - 1)];
  ball.x = dest.x; ball.y = dest.y;
  // eject with some speed in a random downward-ish direction
  const a = rand(Math.PI * 0.15, Math.PI * 0.85);
  const s = rand(7, 10);
  ball.vx = Math.cos(a) * s;
  ball.vy = Math.abs(Math.sin(a) * s);
  dmdFlash('WORMHOLE JUMP', '+' + (1500 * _pb.mult));
  bumpCombo();
}

function onBallLock(ball, T) {
  if (!T.lockZone.active) return;
  if (T.multiballArmed && _pb.balls.length === 1) {
    // START MULTIBALL
    T.lockZone.active = false;
    T.multiballArmed = false;
    snd('multiball');
    dmdFlash('MULTIBALL', 'QUANTUM ENTANGLEMENT');
    _pb.mult = Math.max(_pb.mult, 2);
    // ball that entered is re-ejected, plus 2 more spawn
    ejectFromLock(ball, T);
    for (let i = 0; i < 2; i++) {
      const nb = Ball(T.lockZone.x, T.lockZone.y);
      nb.inLane = false;
      ejectFromLock(nb, T);
      _pb.balls.push(nb);
    }
    setTimeout(() => { if (_table) T.lockZone.active = true; }, 6000);
  } else {
    // not armed: lock just scores + kicks ball out
    addScore(2000 * _pb.mult);
    snd('lock');
    ejectFromLock(ball, T);
  }
}
function ejectFromLock(ball, T) {
  const a = rand(Math.PI * 0.2, Math.PI * 0.8);
  const s = rand(7, 11);
  ball.x = T.lockZone.x; ball.y = T.lockZone.y + T.lockZone.r + 2;
  ball.vx = Math.cos(a) * s;
  ball.vy = Math.abs(Math.sin(a) * s);
  ball.onRamp = null; ball.inLane = false; ball.dead = false;
}


/* ==========================================================================
 * SECTION 17 — GAME LOOP
 * ========================================================================== */
function startGame() {
  _pb = freshPB();
  _pb.highScore = loadHighScore(_table.id);
  _pb.phase = 'plunge';
  _pb.started = true;
  // reset table logic
  resetTableLogic(_table);
  spawnBallInLane();
}
function resetTableLogic(T) {
  T.wormProgress = 0; T.holeProgress = 0; T.activeHoles = 0;
  T.locked = 0; T.multiballArmed = false;
  for (const wh of T.wormholes) { wh.active = false; }
  for (const t of T.targets) { t.hit = false; t.flash = 0; }
  for (const b of T.bumpers) { b.cooldown = 0; b.flash = 0; }
  for (const ln of T.lanes) { ln.lit = false; }
  if (T.lockZone) T.lockZone.active = true;
}
function spawnBallInLane() {
  const pl = _table.plunger;
  const b = Ball(pl.x, pl.bottom - PB.BALL_R - 10);
  b.inLane = true;
  _pb.balls = [b];
  _pb.phase = 'plunge';
  _pb.plungeCharge = 0;
  if (_table.laneGate) _table.laneGate.active = true; // gate solid while in lane
}

function loseBall() {
  _pb.combo = 0; _pb.mult = 1;
  if (_pb.ball >= _pb.ballsTotal) {
    // GAME OVER
    _pb.phase = 'gameover';
    if (_pb.score > _pb.highScore) {
      _pb.highScore = _pb.score;
      saveHighScore(_table.id, _pb.score);
    }
    snd('gameover');
  } else {
    _pb.ball++;
    _pb.phase = 'balllost';
    _pb.dmd.timer = 90;
    setTimeout(() => {
      if (!_running) return;
      resetBallElementsForNewBall(_table);
      spawnBallInLane();
    }, 1600);
  }
}
function resetBallElementsForNewBall(T) {
  // worm holes / progress persist across balls (design choice — keeps it
  // rewarding). Only transient flags reset.
  for (const b of T.bumpers) { b.cooldown = 0; }
}

function tick(now) {
  if (!_running) return;
  _raf = requestAnimationFrame(tick);
  const dtMs = Math.min(50, now - _lastT || 16);
  _lastT = now;
  _pb.tick++;

  // ---- input -> flippers ----
  for (const fl of _table.flippers) {
    const k = fl.side === 'L' ? _keys.left : _keys.right;
    fl.up = k;
    updateFlipper(fl);
  }

  // ---- plunger ----
  if (_pb.phase === 'plunge') {
    const pl = _table.plunger;
    if (_keys.space) {
      _pb.plungeCharge = clamp(_pb.plungeCharge + 0.022, 0, 1);
    }
    pl.headY = lerp(pl.headRest, pl.headDeep, _pb.plungeCharge);
    // keep ball seated on head
    const ball = _pb.balls[0];
    if (ball) { ball.x = pl.x; ball.y = pl.headY - ball.r - 4; }
  }

  // ---- physics ----
  if (_pb.phase === 'play' || _pb.phase === 'plunge') {
    const colliders = assembleColliders(_table);
    // bumper cooldown / flash decay
    for (const b of _table.bumpers) { if (b.cooldown > 0) b.cooldown--; if (b.flash > 0) b.flash--; }
    for (const t of _table.targets) { if (t.flash > 0) t.flash--; }
    for (const wh of _table.wormholes) { wh.swirl += 0.08; }

    for (const ball of _pb.balls) stepBall(ball, _table, colliders);

    // remove drained balls
    const before = _pb.balls.length;
    _pb.balls = _pb.balls.filter(b => !b.dead);
    if (_pb.balls.length === 0 && before > 0 && _pb.phase === 'play') {
      loseBall();
    }
    // combo timer
    if (_pb.comboTimer > 0) { _pb.comboTimer--; if (_pb.comboTimer === 0) _pb.combo = 0; }
    if (_pb.shake > 0) _pb.shake *= 0.85;
  }

  // ---- dmd timer ----
  if (_pb.dmd.timer > 0) _pb.dmd.timer--;
  _pb.dmd.t++;

  // ---- render ----
  drawPlayfield();
  drawDMD();
}

/* launch the ball from the plunger */
function launchBall() {
  if (_pb.phase !== 'plunge') return;
  const ball = _pb.balls[0];
  if (!ball) return;
  const power = _pb.plungeCharge;
  _pb.plungePower = power;
  // deterministic launch: min velocity guarantees lane exit, charge adds more
  ball.vy = -(13 + power * 16);
  ball.inLane = true;            // still in lane, now travelling
  _pb.phase = 'play';
  _pb.plungeCharge = 0;
  _table.plunger.headY = _table.plunger.headRest;
  if (_table.laneGate) _table.laneGate.active = true; // blocks re-entry only
  snd('launch');
  // skill shot: if launched at near-full power, light a lane
  if (power > 0.85) dmdFlash('FULL PLUNGE', 'SKILL SHOT LIT');
}

/* ==========================================================================
 * SECTION 18 — RENDER: PLAYFIELD
 * --------------------------------------------------------------------------
 * The renderer draws the SAME collider data physics uses, plus decorative
 * fills. The ball is drawn with a z-based scale + a drop shadow offset by z,
 * which is what makes ramp elevation read clearly.
 * ========================================================================== */
function drawPlayfield() {
  const ctx = _pfCtx, T = _table;
  const sx = (_pb.shake > 0.4) ? rand(-_pb.shake, _pb.shake) : 0;
  const sy = (_pb.shake > 0.4) ? rand(-_pb.shake, _pb.shake) : 0;
  ctx.save();
  ctx.translate(sx, sy);

  // background gradient
  const g = ctx.createLinearGradient(0, 0, 0, PB.H);
  g.addColorStop(0, T.colors.mid);
  g.addColorStop(1, T.colors.bg);
  ctx.fillStyle = g;
  ctx.fillRect(-20, -20, PB.W + 40, PB.H + 40);

  // subtle starfield
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 60; i++) {
    const x = (i * 97 + 13) % PB.W;
    const y = (i * 173 + 31) % PB.H;
    const tw = 0.5 + 0.5 * Math.sin(_pb.tick * 0.04 + i);
    ctx.globalAlpha = 0.15 + tw * 0.25;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalAlpha = 1;

  // ---- ramps: draw as elevated translucent channels (drawn first, under) ----
  for (const ramp of T.ramps) drawRamp(ctx, ramp);

  // ---- worm holes ----
  for (const wh of T.wormholes) drawWormHole(ctx, wh);

  // ---- ball lock zone ----
  if (T.lockZone) {
    ctx.beginPath();
    ctx.arc(T.lockZone.x, T.lockZone.y, T.lockZone.r, 0, TAU);
    ctx.fillStyle = T.lockZone.active ? 'rgba(255,62,165,0.25)' : 'rgba(80,80,110,0.2)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = T.lockZone.active ? T.colors.neon : '#555';
    ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('LOCK', T.lockZone.x, T.lockZone.y + 3);
  }

  // ---- rollover lanes ----
  for (const ln of T.lanes) {
    ctx.beginPath();
    ctx.arc(ln.x, ln.y, 9, 0, TAU);
    ctx.fillStyle = ln.lit ? T.colors.neon2 : 'rgba(255,255,255,0.15)';
    ctx.fill();
  }

  // ---- static colliders ----
  for (const c of T.staticColliders) drawCollider(ctx, c);
  for (const p of T.posts) drawCollider(ctx, p);

  // ---- bumpers ----
  for (const b of T.bumpers) drawBumper(ctx, b, T);

  // ---- targets ----
  for (const t of T.targets) drawTarget(ctx, t, T);

  // ---- flippers ----
  for (const fl of T.flippers) drawFlipper(ctx, fl, T);

  // ---- plunger ----
  drawPlunger(ctx, T);

  // ---- balls (with z-shadow) ----
  for (const ball of _pb.balls) drawBall(ctx, ball, T);

  // ---- HUD overlays for non-play phases ----
  if (_pb.phase === 'attract') drawAttractOverlay(ctx, T);
  if (_pb.phase === 'gameover') drawGameOverOverlay(ctx, T);

  ctx.restore();
}

function drawCollider(ctx, c) {
  ctx.strokeStyle = c.color || '#4a3f7a';
  ctx.lineCap = 'round';
  if (c.kind === 'seg') {
    ctx.lineWidth = c.r * 2;
    if (c.role === 'sling') { ctx.strokeStyle = c.color; ctx.shadowColor = c.color; ctx.shadowBlur = 12; }
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    ctx.lineTo(c.b.x, c.b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    ctx.beginPath();
    ctx.arc(c.c.x, c.c.y, c.r, 0, TAU);
    ctx.fillStyle = c.color || '#4a3f7a';
    ctx.fill();
  }
}

function drawRamp(ctx, ramp) {
  // draw the channel as a thick translucent stroke; brightness scales with
  // height so the ramp visually "rises".
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // shadow of the ramp on the playfield (offset down-right by max height)
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = ramp.width;
  ctx.beginPath();
  ctx.moveTo(ramp.path[0].x + ramp.h1 * 0.12, ramp.path[0].y + ramp.h1 * 0.12);
  for (let i = 1; i < ramp.path.length; i++)
    ctx.lineTo(ramp.path[i].x + ramp.h1 * 0.12, ramp.path[i].y + ramp.h1 * 0.12);
  ctx.stroke();
  // ramp surface — gradient along its length to suggest the climb
  const grad = ctx.createLinearGradient(ramp.path[0].x, ramp.path[0].y,
    ramp.path[ramp.path.length-1].x, ramp.path[ramp.path.length-1].y);
  grad.addColorStop(0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, hexA(ramp.color, 0.35));
  ctx.strokeStyle = grad;
  ctx.lineWidth = ramp.width;
  ctx.beginPath();
  ctx.moveTo(ramp.path[0].x, ramp.path[0].y);
  for (let i = 1; i < ramp.path.length; i++) ctx.lineTo(ramp.path[i].x, ramp.path[i].y);
  ctx.stroke();
  // glowing rails
  ctx.strokeStyle = ramp.color;
  ctx.shadowColor = ramp.color; ctx.shadowBlur = 8;
  ctx.lineWidth = 3;
  for (const sign of [1, -1]) {
    ctx.beginPath();
    const hw = ramp.width / 2;
    for (let i = 0; i < ramp.path.length; i++) {
      const p0 = ramp.path[Math.max(0, i-1)], p1 = ramp.path[Math.min(ramp.path.length-1, i+1)];
      let nx = -(p1.y - p0.y), ny = (p1.x - p0.x);
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const px = ramp.path[i].x + nx * hw * sign;
      const py = ramp.path[i].y + ny * hw * sign;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // entry arrow marker
  const e = ramp.path[0];
  ctx.fillStyle = ramp.color;
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(_pb.tick * 0.1);
  ctx.beginPath();
  ctx.arc(e.x, e.y, 6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawWormHole(ctx, wh) {
  ctx.save();
  const pulse = 0.6 + 0.4 * Math.sin(_pb.tick * 0.08 + wh.idx);
  if (wh.active) {
    // swirling vortex
    for (let r = wh.r + 12; r > 3; r -= 4) {
      ctx.beginPath();
      ctx.arc(wh.x, wh.y, r, wh.swirl + r * 0.3, wh.swirl + r * 0.3 + Math.PI * 1.3);
      ctx.strokeStyle = hexA('#39d7ff', 0.15 + (1 - r / (wh.r + 12)) * 0.6);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(wh.x, wh.y, wh.r * 0.5, 0, TAU);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.shadowColor = '#39d7ff'; ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(wh.x, wh.y, wh.r, 0, TAU);
    ctx.strokeStyle = '#39d7ff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    // dormant — faint ring
    ctx.beginPath();
    ctx.arc(wh.x, wh.y, wh.r, 0, TAU);
    ctx.strokeStyle = hexA('#5b4b9e', 0.4 + pulse * 0.2);
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawBumper(ctx, b, T) {
  ctx.save();
  const flash = b.flash / 12;
  // base ring
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r + 4, 0, TAU);
  ctx.fillStyle = hexA(T.colors.neon, 0.2);
  ctx.fill();
  // body
  const g = ctx.createRadialGradient(b.x - 6, b.y - 6, 2, b.x, b.y, b.r);
  g.addColorStop(0, flash > 0 ? '#fff' : '#ffd6f0');
  g.addColorStop(1, T.colors.neon);
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, TAU);
  ctx.fillStyle = g;
  if (flash > 0) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 20 * flash; }
  ctx.fill();
  ctx.shadowBlur = 0;
  // cap
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r * 0.45, 0, TAU);
  ctx.fillStyle = flash > 0 ? '#fff' : '#fff8';
  ctx.fill();
  ctx.restore();
}

function drawTarget(ctx, t, T) {
  ctx.save();
  const flash = t.flash / 18;
  const col = t.hit ? '#3a3a55' : (flash > 0 ? '#fff' : T.colors.neon2);
  ctx.fillStyle = col;
  if (flash > 0) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 14 * flash; }
  ctx.fillRect(t.x - t.w/2, t.y - t.h/2, t.w, t.h);
  ctx.shadowBlur = 0;
  // letter
  ctx.fillStyle = t.hit ? '#888' : '#0a0a1f';
  ctx.font = 'bold 16px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t.letter, t.x, t.y + 1);
  ctx.restore();
}

function drawFlipper(ctx, fl, T) {
  const tip = flipperTip(fl);
  ctx.save();
  ctx.lineCap = 'round';
  // shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = fl.r * 2;
  ctx.beginPath();
  ctx.moveTo(fl.px + 3, fl.py + 4);
  ctx.lineTo(tip.x + 3, tip.y + 4);
  ctx.stroke();
  // body
  const g = ctx.createLinearGradient(fl.px, fl.py, tip.x, tip.y);
  g.addColorStop(0, '#fff');
  g.addColorStop(1, T.colors.neon);
  ctx.strokeStyle = g;
  ctx.lineWidth = fl.r * 2;
  ctx.beginPath();
  ctx.moveTo(fl.px, fl.py);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  // pivot hub
  ctx.beginPath();
  ctx.arc(fl.px, fl.py, fl.r + 2, 0, TAU);
  ctx.fillStyle = '#222';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(fl.px, fl.py, fl.r * 0.5, 0, TAU);
  ctx.fillStyle = T.colors.neon2;
  ctx.fill();
  ctx.restore();
}

function drawPlunger(ctx, T) {
  const pl = T.plunger;
  ctx.save();
  // lane floor tint
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(pl.laneL + 4, pl.top, pl.laneR - pl.laneL - 8, pl.bottom - pl.top);
  // plunger shaft
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(pl.x, pl.headY + 14);
  ctx.lineTo(pl.x, pl.bottom + 30);
  ctx.stroke();
  // plunger head
  const charging = _pb.phase === 'plunge' && _pb.plungeCharge > 0;
  ctx.fillStyle = charging ? T.colors.neon : '#bbb';
  ctx.fillRect(pl.x - 14, pl.headY, 28, 14);
  // charge meter
  if (_pb.phase === 'plunge') {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(pl.laneL + 6, pl.bottom - 4, pl.laneR - pl.laneL - 12, 6);
    ctx.fillStyle = T.colors.neon2;
    ctx.fillRect(pl.laneL + 6, pl.bottom - 4,
      (pl.laneR - pl.laneL - 12) * _pb.plungeCharge, 6);
  }
  ctx.restore();
}

function drawBall(ctx, ball, T) {
  // z gives a scale boost + a separated shadow. The bigger the gap between
  // the ball and its shadow, the higher it reads.
  const zScale = 1 + ball.z / 220;          // up to ~1.3x at full ramp height
  const shadowOff = ball.z * 0.16;          // shadow offset grows with height
  const r = ball.r * zScale;
  // trail
  for (let i = 0; i < ball.trail.length; i++) {
    const tp = ball.trail[i];
    const a = (i / ball.trail.length) * 0.35;
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, ball.r * (0.4 + i / ball.trail.length * 0.5), 0, TAU);
    ctx.fillStyle = hexA(T.colors.neon2, a);
    ctx.fill();
  }
  // shadow
  ctx.beginPath();
  ctx.ellipse(ball.x + shadowOff, ball.y + shadowOff, ball.r * 0.95, ball.r * 0.7, 0, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  // ball body
  const g = ctx.createRadialGradient(
    ball.x - r * 0.35, ball.y - r * 0.35, r * 0.15,
    ball.x, ball.y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, '#c8d2e0');
  g.addColorStop(1, '#5a6478');
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, r, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  // specular highlight
  ctx.beginPath();
  ctx.arc(ball.x - r * 0.3, ball.y - r * 0.3, r * 0.28, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  // elevation ring when on a ramp
  if (ball.z > 4) {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, r + 3, 0, TAU);
    ctx.strokeStyle = hexA(T.colors.neon2, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawAttractOverlay(ctx, T) {
  ctx.fillStyle = 'rgba(5,5,20,0.78)';
  ctx.fillRect(-20, -20, PB.W + 40, PB.H + 40);
  ctx.textAlign = 'center';
  ctx.fillStyle = T.colors.neon;
  ctx.font = 'bold 44px "Courier New", monospace';
  ctx.fillText(T.name, PB.W / 2, PB.H / 2 - 40);
  ctx.fillStyle = '#fff';
  ctx.font = '16px monospace';
  ctx.fillText('PRESS LAUNCH OR SPACE TO PLAY', PB.W / 2,
    PB.H / 2 + 10 + Math.sin(_pb.tick * 0.08) * 2);
  ctx.fillStyle = T.colors.neon2;
  ctx.font = '13px monospace';
  ctx.fillText('HIGH SCORE  ' + loadHighScore(T.id).toLocaleString(),
    PB.W / 2, PB.H / 2 + 50);
}
function drawGameOverOverlay(ctx, T) {
  ctx.fillStyle = 'rgba(5,5,20,0.82)';
  ctx.fillRect(-20, -20, PB.W + 40, PB.H + 40);
  ctx.textAlign = 'center';
  ctx.fillStyle = T.colors.neon;
  ctx.font = 'bold 40px "Courier New", monospace';
  ctx.fillText('GAME OVER', PB.W / 2, PB.H / 2 - 30);
  ctx.fillStyle = '#fff';
  ctx.font = '20px monospace';
  ctx.fillText('SCORE  ' + _pb.score.toLocaleString(), PB.W / 2, PB.H / 2 + 14);
  ctx.fillStyle = T.colors.neon2;
  ctx.font = '13px monospace';
  ctx.fillText('PRESS LAUNCH TO PLAY AGAIN', PB.W / 2, PB.H / 2 + 60);
}

// hex + alpha helper
function hexA(hex, a) {
  if (!hex) return `rgba(255,255,255,${a})`;
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}


/* ==========================================================================
 * SECTION 19 — RENDER: DMD (dot-matrix display)
 * --------------------------------------------------------------------------
 * Build a virtual dot grid, then render it as glowing dots on the canvas.
 * Phases: attract / play / flash / balllost / gameover.
 * Future per-table animations slot into the attract + flash branches.
 * ========================================================================== */
function newGrid() {
  const g = [];
  for (let r = 0; r < DMD.rows; r++) g.push(new Array(DMD.cols).fill(0));
  return g;
}
function drawDMD() {
  const ctx = _dmdCtx;
  const grid = newGrid();
  const T = _table;

  if (_pb.dmd.timer > 0) {
    // FLASH message takes over
    dmdTextCentered(grid, _pb.dmd.msg.substring(0, 16), 5, 1);
    if (_pb.dmd.sub) dmdTextCentered(grid, _pb.dmd.sub.substring(0, 16), 15, 1);
  } else if (_pb.phase === 'attract') {
    dmdTextCentered(grid, T.name.substring(0, 16), 3, 1);
    dmdTextCentered(grid, 'PRESS LAUNCH', 13, (_pb.dmd.t >> 4) & 1);
    dmdText(grid, 'HI ' + shortNum(loadHighScore(T.id)), 2, 21, 1);
  } else if (_pb.phase === 'gameover') {
    dmdTextCentered(grid, 'GAME OVER', 4, 1);
    dmdTextCentered(grid, shortNum(_pb.score), 14, 1);
  } else if (_pb.phase === 'balllost') {
    dmdTextCentered(grid, 'BALL LOST', 6, 1);
    dmdTextCentered(grid, 'BALL ' + _pb.ball, 16, 1);
  } else {
    // PLAY: score big, ball + mult on a status line
    const scoreStr = shortNum(_pb.score);
    dmdText(grid, scoreStr, Math.max(2, DMD.cols - scoreStr.length * 6 - 2), 3, 1);
    dmdText(grid, 'BALL ' + _pb.ball + '/' + _pb.ballsTotal, 2, 3, 1);
    dmdText(grid, 'X' + _pb.mult, 2, 14, 1);
    if (_pb.combo > 1) dmdText(grid, 'COMBO ' + _pb.combo, 30, 14, 1);
    if (_pb.balls.length > 1) dmdText(grid, _pb.balls.length + ' BALLS', 2, 21, ((_pb.dmd.t>>3)&1));
  }

  // ---- render the grid as dots ----
  const cw = DMD.dot, ch = DMD.dot;
  const offX = (PB.DMD_W - DMD.cols * cw) / 2;
  const offY = (PB.DMD_H - DMD.rows * ch) / 2;
  // panel background
  ctx.fillStyle = '#0a0d08';
  ctx.fillRect(0, 0, PB.DMD_W, PB.DMD_H);
  for (let r = 0; r < DMD.rows; r++) {
    for (let c = 0; c < DMD.cols; c++) {
      const on = grid[r][c];
      const x = offX + c * cw, y = offY + r * ch;
      if (on) {
        ctx.fillStyle = '#ff8a1e';
        ctx.shadowColor = '#ff8a1e'; ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(x + cw/2, y + ch/2, cw * 0.42, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = 'rgba(80,55,20,0.22)';
        ctx.beginPath();
        ctx.arc(x + cw/2, y + ch/2, cw * 0.30, 0, TAU);
        ctx.fill();
      }
    }
  }
}
function shortNum(n) {
  return Math.round(n).toString();
}

/* ==========================================================================
 * SECTION 20 — HIGH SCORE PERSISTENCE
 * ========================================================================== */
function loadHighScore(id) {
  try { return parseInt(localStorage.getItem('pinball_hi_' + id) || '0', 10) || 0; }
  catch (e) { return 0; }
}
function saveHighScore(id, score) {
  try { localStorage.setItem('pinball_hi_' + id, String(score)); } catch (e) {}
}

/* ==========================================================================
 * SECTION 21 — TABLE FACTORY
 * --------------------------------------------------------------------------
 * buildTable() returns a fully-built table or a 'placeholder' marker for the
 * not-yet-built games. Adding a real table later = add a builder + case.
 * ========================================================================== */
function buildTable(id, tdef) {
  switch (id) {
    case 'worm_holer':    return buildWormHoler(tdef);
    case 'barfs_house':   return { placeholder: true, id, name: tdef?.name || "BARF'S HOUSE" };
    case 'shower_defense':return { placeholder: true, id, name: tdef?.name || 'SHOWER DEFENSE' };
    default:              return buildWormHoler(tdef);
  }
}

/* ==========================================================================
 * SECTION 22 — UI / OVERLAY
 * --------------------------------------------------------------------------
 * Builds the full-screen overlay: a cabinet shell containing the DMD canvas
 * stacked above the playfield canvas, with LEFT / LAUNCH / RIGHT buttons.
 *
 * IMPORTANT (historical bug): window.pbK and window.pbClose must be assigned
 * BEFORE overlay innerHTML is set, because the button onclick attributes
 * resolve in window scope. We instead attach listeners via addEventListener
 * after insertion, which is robust and avoids the global entirely.
 * ========================================================================== */
function buildUI() {
  _ov = document.createElement('div');
  _ov.id = 'pinball-overlay';
  _ov.innerHTML = `
    <style>
      #pinball-overlay{position:fixed;inset:0;z-index:99999;
        background:radial-gradient(circle at 50% 30%, #1a1145 0%, #05050f 80%);
        display:flex;align-items:center;justify-content:center;
        font-family:'Courier New',monospace;user-select:none;-webkit-user-select:none;
        touch-action:none;}
      .pb-shell{display:flex;flex-direction:column;align-items:center;
        gap:8px;max-height:100vh;padding:8px;box-sizing:border-box;}
      .pb-dmd{border:3px solid #2a2a3a;border-radius:8px;
        box-shadow:0 0 24px rgba(255,138,30,0.25),inset 0 0 12px #000;
        background:#0a0d08;image-rendering:pixelated;}
      .pb-pf{border:4px solid #2a2a3a;border-radius:10px;
        box-shadow:0 0 40px rgba(57,215,255,0.18);background:#05050f;}
      .pb-controls{display:flex;gap:10px;width:100%;max-width:540px;}
      .pb-btn{flex:1;padding:16px 0;font-family:'Courier New',monospace;
        font-weight:bold;font-size:15px;letter-spacing:1px;border:none;
        border-radius:10px;color:#fff;cursor:pointer;
        background:linear-gradient(180deg,#3a2f6a,#1a1145);
        box-shadow:0 4px 0 #0a0820, 0 0 16px rgba(255,62,165,0.2);
        transition:transform .04s,box-shadow .04s;}
      .pb-btn:active,.pb-btn.pb-held{transform:translateY(3px);
        box-shadow:0 1px 0 #0a0820,0 0 24px rgba(255,62,165,0.4);}
      .pb-btn.pb-launch{background:linear-gradient(180deg,#ff3ea5,#a01060);}
      .pb-close{position:absolute;top:14px;right:16px;width:38px;height:38px;
        border-radius:50%;border:2px solid #5b4b9e;background:#1a1145;
        color:#fff;font-size:18px;cursor:pointer;line-height:1;}
      .pb-hint{color:#5b4b9e;font-size:11px;letter-spacing:1px;}
    </style>
    <button class="pb-close" title="Close (Esc)">✕</button>
    <div class="pb-shell">
      <canvas class="pb-dmd"  width="${PB.DMD_W}" height="${PB.DMD_H}"></canvas>
      <canvas class="pb-pf"   width="${PB.W}"     height="${PB.H}"></canvas>
      <div class="pb-controls">
        <button class="pb-btn pb-left">◀ LEFT</button>
        <button class="pb-btn pb-launch">LAUNCH</button>
        <button class="pb-btn pb-right">RIGHT ▶</button>
      </div>
      <div class="pb-hint">◀ ▶ FLIPPERS &nbsp;·&nbsp; SPACE / LAUNCH = PLUNGER &nbsp;·&nbsp; ESC = EXIT</div>
    </div>`;
  document.body.appendChild(_ov);

  _dmdCanvas = _ov.querySelector('.pb-dmd');
  _dmdCtx = _dmdCanvas.getContext('2d');
  _pfCanvas = _ov.querySelector('.pb-pf');
  _pfCtx = _pfCanvas.getContext('2d');

  // scale playfield to fit viewport height
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // ---- button wiring (LEFT / RIGHT held; LAUNCH press+hold for plunger) ----
  const lBtn = _ov.querySelector('.pb-left');
  const rBtn = _ov.querySelector('.pb-right');
  const launchBtn = _ov.querySelector('.pb-launch');
  const closeBtn = _ov.querySelector('.pb-close');

  bindHold(lBtn, () => setKey('left', true), () => setKey('left', false));
  bindHold(rBtn, () => setKey('right', true), () => setKey('right', false));
  bindHold(launchBtn,
    () => { onLaunchPress(); launchBtn.classList.add('pb-held'); },
    () => { onLaunchRelease(); launchBtn.classList.remove('pb-held'); });
  closeBtn.addEventListener('click', closePinball);

  // keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

function fitCanvas() {
  if (!_pfCanvas) return;
  const avail = window.innerHeight - 240; // room for dmd + controls
  const scale = Math.min(1, avail / PB.H, (window.innerWidth - 24) / PB.W);
  _pfCanvas.style.width  = (PB.W * scale) + 'px';
  _pfCanvas.style.height = (PB.H * scale) + 'px';
  _dmdCanvas.style.width  = (PB.W * scale) + 'px';
  _dmdCanvas.style.height = (PB.DMD_H * (PB.W * scale / PB.DMD_W)) + 'px';
}

function bindHold(el, onDown, onUp) {
  const down = e => { e.preventDefault(); resumeAudio(); onDown(); el.classList.add('pb-held'); };
  const up   = e => { e.preventDefault(); onUp(); el.classList.remove('pb-held'); };
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
  el.addEventListener('mouseleave', up);
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend', up, { passive: false });
  el.addEventListener('touchcancel', up, { passive: false });
}

function setKey(which, val) { _keys[which] = val; }

function onLaunchPress() {
  resumeAudio();
  if (_pb.phase === 'attract' || _pb.phase === 'gameover') {
    startGame();
    return;
  }
  if (_pb.phase === 'plunge') _keys.space = true;
}
function onLaunchRelease() {
  if (_pb.phase === 'plunge' && _keys.space) {
    _keys.space = false;
    launchBall();
  }
}

function onKeyDown(e) {
  if (e.repeat) return;
  resumeAudio();
  switch (e.key) {
    case 'ArrowLeft':  _keys.left = true; e.preventDefault(); break;
    case 'ArrowRight': _keys.right = true; e.preventDefault(); break;
    case ' ': case 'Spacebar':
      e.preventDefault();
      onLaunchPress();
      break;
    case 'Escape': closePinball(); break;
  }
}
function onKeyUp(e) {
  switch (e.key) {
    case 'ArrowLeft':  _keys.left = false; break;
    case 'ArrowRight': _keys.right = false; break;
    case ' ': case 'Spacebar': onLaunchRelease(); break;
  }
}

/* ==========================================================================
 * SECTION 23 — PLACEHOLDER SCREEN (Barf's House / Shower Defense)
 * ========================================================================== */
function runPlaceholder(table) {
  // simple static "coming soon" screen drawn into the playfield canvas
  const ctx = _pfCtx;
  function draw() {
    if (!_running) return;
    _raf = requestAnimationFrame(draw);
    ctx.fillStyle = '#05050f';
    ctx.fillRect(0, 0, PB.W, PB.H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff3ea5';
    ctx.font = 'bold 34px "Courier New",monospace';
    ctx.fillText(table.name, PB.W/2, PB.H/2 - 60);
    ctx.fillStyle = '#39d7ff';
    ctx.font = '18px monospace';
    ctx.fillText('TABLE UNDER CONSTRUCTION', PB.W/2, PB.H/2);
    ctx.fillStyle = '#5b4b9e';
    ctx.font = '13px monospace';
    ctx.fillText('Coming in a future update.', PB.W/2, PB.H/2 + 36);
    ctx.fillText('Press ESC to return.', PB.W/2, PB.H/2 + 58);
    // DMD shows the table name scrolling
    const grid = newGrid();
    dmdTextCentered(grid, table.name.substring(0,16), 5, 1);
    dmdTextCentered(grid, 'COMING SOON', 15, (( _pb.dmd?.t ?? 0)>>4)&1 || 1);
    renderGridToDMD(grid);
    if (_pb.dmd) _pb.dmd.t++;
  }
  _pb = freshPB();
  draw();
}
function renderGridToDMD(grid) {
  const ctx = _dmdCtx;
  const cw = DMD.dot, ch = DMD.dot;
  const offX = (PB.DMD_W - DMD.cols * cw) / 2;
  const offY = (PB.DMD_H - DMD.rows * ch) / 2;
  ctx.fillStyle = '#0a0d08';
  ctx.fillRect(0, 0, PB.DMD_W, PB.DMD_H);
  for (let r = 0; r < DMD.rows; r++) for (let c = 0; c < DMD.cols; c++) {
    const x = offX + c*cw, y = offY + r*ch;
    if (grid[r][c]) {
      ctx.fillStyle = '#ff8a1e'; ctx.shadowColor = '#ff8a1e'; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(x+cw/2, y+ch/2, cw*0.42, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = 'rgba(80,55,20,0.22)';
      ctx.beginPath(); ctx.arc(x+cw/2, y+ch/2, cw*0.30, 0, TAU); ctx.fill();
    }
  }
}

/* ==========================================================================
 * SECTION 24 — LIFECYCLE / EXPORT
 * ========================================================================== */
async function loadTableDef(id) {
  try {
    const res = await fetch('./data/pinball_tables.json');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.tables || []).find(t => t.id === id) || null;
  } catch (e) { return null; }
}

/**
 * openPinball(tableId, state?, data?, api?)
 * state/data/api are optional SPACED engine references; null = standalone.
 */
export async function openPinball(tableId = 'worm_holer', state = null, data = null, api = null) {
  if (_running) return;            // already open
  _running = true;
  _spaced = (state || data || api) ? { state, data, api } : null;

  _tdef = await loadTableDef(tableId);
  _table = buildTable(tableId, _tdef);

  initAudio();
  buildUI();
  _pb = freshPB();
  _lastT = performance.now();

  if (_table.placeholder) {
    runPlaceholder(_table);
    return;
  }

  _pb.phase = 'attract';
  _pb.highScore = loadHighScore(_table.id);
  _raf = requestAnimationFrame(tick);
}

/** closePinball() — full teardown. Safe to call multiple times. */
export function closePinball() {
  if (!_running) return;
  _running = false;
  cancelAnimationFrame(_raf);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('resize', fitCanvas);
  if (_ac) { try { _ac.close(); } catch (e) {} _ac = null; }
  if (_ov && _ov.parentNode) _ov.parentNode.removeChild(_ov);
  _ov = null; _pfCanvas = _pfCtx = _dmdCanvas = _dmdCtx = null;
  _table = null; _tdef = null; _spaced = null;
  _keys.left = _keys.right = _keys.space = false;
}

// convenience: expose on window for SPACED tile triggers / debugging
if (typeof window !== 'undefined') {
  window.openPinball = openPinball;
  window.closePinball = closePinball;
}
