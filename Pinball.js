/* ============================================================================
 * PINBALL BUDDY — Pinball.js
 * v0.004    — full physics rebuild
 * v0.004.1  — lane-feed arc, top-right hood redesign, flipper-gap drain fix
 * v0.005    — swept flipper collision, DMD animations+attract reel, initials
 *             entry, high-score table, credit/match/free-game, teleport holes
 * v0.006    — DMD layout fix, shot sequence, modes, ramp combos, extra balls,
 *             lit teleport holes, story beats (all table-data-driven for reuse)
 * v0.007    — COSMIC CLUCKERS (alien diner, upper-deck booths, sitcom beats)
 *             and SHOWER DEFENSE (waves, shower toggle, drain beast). Shared
 *             cabinet frame, table-driven dispatch (onBankComplete, onLanesComplete).
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
  DMD_W: 540, DMD_H: 168,   // dot-matrix display canvas px (extra padding around 26-row grid)
};

// playfield bounding walls (used by every table)
const WALL = { L: 26, R: 514, T: 26, DRAIN_Y: 944 };

export const PB_VERSION = 'v0.007';

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
    dmd: { mode: 'attract', msg: '', sub: '', timer: 0, t: 0,
           queue: [], animT: 0 },
    initials: { active: false, slot: 0, idx: 0, letters: [' ', ' ', ' '] },
    credits: 0,
    modeName: '',
    modeTimer: 0,
    tick: 0,
    shake: 0,
    started: false,
    highScore: 0,
    // end-of-game flow
    endStage: null,        // gameover | initials | highscore | match | freegame | done
    endQualifies: false,
    matchWon: false,
    pendingFreeGame: null,
    // shot sequence (table-driven)
    shot: { idx: 0, hits: 0, completedThisGame: 0 },
    // active mode (table-driven, exclusive)
    mode: { name: null, framesLeft: 0, mult: 1, hookType: null, label: '' },
    // ramp combo tracking (chain of distinct ramps within window)
    rampCombo: { lastId: null, timer: 0, count: 0 },
    // extra balls earned this game (added to ballsTotal)
    extraBallsEarned: 0,
    extraBallLitForHole: null,    // teleport-hole-driven extra ball, if armed
    // story beats already shown this game (don't repeat)
    storyShown: {},
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
    flipHitFrame: -1,     // last frame this ball took a flipper power-punch
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
    // ---- animation / DMD cues -------------------------------------------
    case 'gameStart': [523,659,784,1046,1318].forEach((f,i)=>setTimeout(()=>tone(f,0.18,'square',0.15),i*80)); break;
    case 'whoosh':   noise(0.35, 0.13, 900); break;
    case 'clunk':    tone(110, 0.12, 'square', 0.16); break;
    case 'warp':     tone(1200, 0.3, 'sine', 0.14, 180); noise(0.3, 0.08, 1400); break;
    case 'teleport': [660,880,1100].forEach((f,i)=>setTimeout(()=>tone(f,0.16,'sine',0.13,f*1.4),i*70)); break;
    case 'blackhole':tone(70, 0.7, 'sawtooth', 0.18, 30); noise(0.7, 0.12, 200); break;
    case 'highscore':[523,659,784,1046,784,1046,1318].forEach((f,i)=>setTimeout(()=>tone(f,0.2,'square',0.16),i*110)); break;
    // the classic pinball "knocker" pop — used for free game / match win
    case 'pop':      tone(90, 0.09, 'square', 0.22); noise(0.06, 0.18, 400); break;
    case 'buzz':     tone(120, 0.35, 'sawtooth', 0.16, 80); break;
    case 'freegame': [784,1046,1318].forEach((f,i)=>setTimeout(()=>{tone(f,0.15,'square',0.16);},i*90));
                     setTimeout(()=>snd('pop'), 300); break;
    case 'matchroll':[ ]; { let i=0; const r=()=>{ if(i<14){ tone(300+((i*7)%9)*40,0.05,'square',0.10); i++; setTimeout(r,70);} }; r(); } break;
    case 'attractStart': tone(330, 0.25, 'triangle', 0.10, 660); break;
    case 'cursor':   tone(520, 0.04, 'square', 0.08); break;
    case 'confirm':  tone(784, 0.12, 'square', 0.14, 1046); break;
    case 'holeOpen': tone(440, 0.14, 'sine', 0.11, 760); break;
    // ---- table-systems cues ---------------------------------------------
    case 'shotLit':         tone(880, 0.14, 'square', 0.14, 1320); break;
    case 'shotSequenceWin': [523,659,784,1046,1318,1568].forEach((f,i)=>setTimeout(()=>tone(f,0.18,'square',0.16),i*70)); break;
    case 'modeStart':       [392,523,659,880].forEach((f,i)=>setTimeout(()=>tone(f,0.2,'triangle',0.16),i*80)); break;
    case 'modeEnd':         tone(220, 0.3, 'sawtooth', 0.13, 110); break;
    case 'combo':           tone(659, 0.12, 'square', 0.14, 988); break;
    case 'extraBall':       [523,659,784,1046,1318].forEach((f,i)=>setTimeout(()=>tone(f,0.22,'sine',0.16),i*90)); break;
    case 'story':           tone(330, 0.12, 'triangle', 0.10, 440); break;
    // ---- Cosmic Cluckers cues ------------------------------------------
    case 'orderUp':         [880,659,523].forEach((f,i)=>setTimeout(()=>tone(f,0.14,'square',0.14),i*70)); break;
    case 'bell':            tone(1568, 0.16, 'sine', 0.18, 2093); break;
    case 'doorBell':        [659, 523].forEach((f,i)=>setTimeout(()=>tone(f,0.25,'sine',0.16),i*180)); break;
    case 'cashRegister':    [1318,988,1568].forEach((f,i)=>setTimeout(()=>tone(f,0.12,'square',0.14),i*60)); noise(0.15,0.10,2000); break;
    case 'sizzle':          noise(0.4, 0.12, 3000); break;
    // ---- Shower Defense cues -------------------------------------------
    case 'bugSquish':       noise(0.15, 0.18, 800); tone(180,0.10,'sawtooth',0.12,80); break;
    case 'moldSplat':       noise(0.25, 0.15, 400); break;
    case 'showerOn':        noise(0.6, 0.16, 1800); tone(440,0.4,'sine',0.10,880); break;
    case 'shower':          noise(0.25, 0.14, 2200); break;
    case 'drainBeast':      tone(60, 0.5, 'sawtooth', 0.20, 30); noise(0.5, 0.14, 200); break;
    case 'beastRoar':       tone(80, 0.8, 'sawtooth', 0.22, 40); noise(0.8, 0.16, 300); break;
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
 * SECTION 7b — DMD ANIMATION ENGINE
 * --------------------------------------------------------------------------
 * A small frame-based cutscene system layered on top of the dot grid. An
 * "animation" is { dur, render(grid, p, t), sound? } where p is 0..1 progress
 * and t is the raw frame count. Animations are pushed to a queue; drawDMD
 * plays the head of the queue. Event animations are SHORT (~3s); the attract
 * sequence is a long looping reel. None of this touches physics.
 *
 * Helper draw primitives all work on the virtual dot grid (108 x 26).
 * ========================================================================== */

// ---- low-level dot primitives ------------------------------------------
function dmdDot(grid, x, y, on = 1) {
  x = x | 0; y = y | 0;
  if (x >= 0 && x < DMD.cols && y >= 0 && y < DMD.rows) grid[y][x] = on;
}
function dmdRect(grid, x, y, w, h, on = 1) {
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) dmdDot(grid, x + c, y + r, on);
}
function dmdBox(grid, x, y, w, h, on = 1) {
  for (let c = 0; c < w; c++) { dmdDot(grid, x + c, y, on); dmdDot(grid, x + c, y + h - 1, on); }
  for (let r = 0; r < h; r++) { dmdDot(grid, x, y + r, on); dmdDot(grid, x + w - 1, y + r, on); }
}
function dmdCircle(grid, cx, cy, rad, on = 1, fill = false) {
  const r2 = rad * rad;
  for (let y = -rad; y <= rad; y++) {
    for (let x = -rad; x <= rad; x++) {
      const d = x * x + y * y;
      if (fill ? d <= r2 : (d <= r2 && d > (rad - 1.4) * (rad - 1.4)))
        dmdDot(grid, cx + x, cy + y, on);
    }
  }
}
function dmdLine(grid, x0, y0, x1, y1, on = 1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    dmdDot(grid, x0, y0, on);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
// width of a string in dots
function dmdTextWidth(str) { return String(str).length * 6 - 1; }

// ---- animation queue ----------------------------------------------------
function dmdPlay(anim) {
  // anim: { dur, render, sound, loop?, name? }
  if (!_pb.dmd.queue) _pb.dmd.queue = [];
  _pb.dmd.queue.push(anim);
  if (_pb.dmd.queue.length === 1) { _pb.dmd.animT = 0; if (anim.sound) snd(anim.sound); }
}
function dmdPlayExclusive(anim) {
  // clear queue and play immediately (used for big interrupts)
  _pb.dmd.queue = [anim];
  _pb.dmd.animT = 0;
  if (anim.sound) snd(anim.sound);
}
function dmdClearQueue() { _pb.dmd.queue = []; _pb.dmd.animT = 0; }
function dmdBusy() { return _pb.dmd.queue && _pb.dmd.queue.length > 0; }

// advance the animation queue one frame; returns the grid to draw, or null
function dmdStepAnim() {
  const q = _pb.dmd.queue;
  if (!q || q.length === 0) return null;
  const anim = q[0];
  const grid = newGrid();
  const p = anim.dur > 0 ? Math.min(1, _pb.dmd.animT / anim.dur) : 1;
  anim.render(grid, p, _pb.dmd.animT);
  _pb.dmd.animT++;
  // fire mid-animation sound cues
  if (anim.cues) {
    for (const cue of anim.cues) {
      if (cue.at === _pb.dmd.animT) snd(cue.snd);
    }
  }
  if (_pb.dmd.animT > anim.dur) {
    if (anim.loop) { _pb.dmd.animT = 0; }
    else {
      q.shift();
      _pb.dmd.animT = 0;
      if (q.length && q[0].sound) snd(q[0].sound);
    }
  }
  return grid;
}

/* ==========================================================================
 * SECTION 7c — DMD ANIMATION LIBRARY
 * --------------------------------------------------------------------------
 * All cutscenes and the attract reel, drawn in the dot-matrix style. Event
 * animations run ~3s (180 frames); the attract reel is a ~30s loop.
 * Every animation that should be heard names a `sound` (played on start)
 * and/or `cues` (sounds at specific frames).
 * ========================================================================== */

// shared little dot-art helpers ------------------------------------------
// a swirling black-hole motif used in several Worm Holer animations
function dmdBlackHole(grid, cx, cy, t, scale = 1) {
  const arms = 3;
  for (let a = 0; a < arms; a++) {
    for (let r = 1; r < 11 * scale; r++) {
      const ang = a * (TAU / arms) + t * 0.13 + r * 0.42;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r * 0.62;
      dmdDot(grid, x, y, 1);
    }
  }
  dmdCircle(grid, cx, cy, Math.max(1, 2 * scale), 1, true);
}
// a small pinball with a highlight
function dmdBall(grid, cx, cy, rad = 3) {
  dmdCircle(grid, cx, cy, rad, 1, true);
  dmdDot(grid, cx - 1, cy - 1, 0);
}
// starfield twinkle
function dmdStars(grid, t, seed = 1) {
  for (let i = 0; i < 24; i++) {
    const x = ((i * 47 + seed * 13) % DMD.cols);
    const y = ((i * 29 + seed * 7) % DMD.rows);
    if (((t >> 3) + i) % 5 !== 0) dmdDot(grid, x, y, 1);
  }
}

// ---- EVENT ANIMATIONS (each ~180 frames / 3s) --------------------------
function animGameStart(table) {
  return {
    dur: 150, sound: 'gameStart',
    cues: [{ at: 70, snd: 'whoosh' }],
    render(grid, p, t) {
      dmdStars(grid, t, 3);
      // title rushes in from the sides and settles
      const name = table.name.toUpperCase().substring(0, 16);
      const w = dmdTextWidth(name);
      const tx = Math.floor((DMD.cols - w) / 2);
      const slide = Math.round((1 - Math.min(1, p * 1.8)) * 60);
      dmdText(grid, name, tx - slide, 6, 1);
      if (p > 0.5) {
        const sub = 'BALL 1 - GO';
        dmdTextCentered(grid, sub, 16, (t >> 3) & 1);
      }
    },
  };
}
function animGameOver(table, score, isHigh) {
  return {
    dur: 200, sound: 'gameover',
    render(grid, p, t) {
      // collapsing black hole swallows the field
      const cx = DMD.cols / 2, cy = DMD.rows / 2;
      const sc = Math.max(0.2, 1 - p);
      dmdBlackHole(grid, cx, cy, t, sc);
      if (p > 0.35) dmdTextCentered(grid, 'GAME OVER', 4, 1);
      if (p > 0.6) dmdTextCentered(grid, shortNum(score), 17, 1);
      if (p > 0.6 && isHigh) dmdTextCentered(grid, 'GREAT SCORE', 17, ((t >> 3) & 1));
    },
  };
}
function animBallLock() {
  return {
    dur: 165, sound: 'lock',
    cues: [{ at: 60, snd: 'clunk' }],
    render(grid, p, t) {
      const cx = DMD.cols / 2;
      // a ball falls into a hole and the hole shuts
      const by = Math.min(13, 2 + p * 26);
      if (p < 0.55) dmdBall(grid, cx, by, 3);
      // the hole iris
      const iris = p < 0.55 ? 6 : Math.round(6 * (1 - (p - 0.55) / 0.45));
      dmdCircle(grid, cx, 14, Math.max(1, iris), 1, false);
      dmdTextCentered(grid, 'BALL LOCKED', 19, p > 0.4 ? 1 : 0);
    },
  };
}
function animMultiball() {
  return {
    dur: 200, sound: 'multiball',
    cues: [{ at: 40, snd: 'whoosh' }, { at: 110, snd: 'pop' }],
    render(grid, p, t) {
      dmdStars(grid, t, 5);
      const cx = DMD.cols / 2, cy = 9;
      dmdBlackHole(grid, cx, cy, t, 1);
      // balls scatter outward from the hole
      const n = 5;
      for (let i = 0; i < n; i++) {
        const ang = i * (TAU / n) + t * 0.05;
        const rr = p * 40;
        dmdBall(grid, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.6, 2);
      }
      dmdTextCentered(grid, 'MULTIBALL', 19, (t >> 2) & 1);
    },
  };
}
function animBlackHole() {
  return {
    dur: 180, sound: 'blackhole',
    cues: [{ at: 90, snd: 'whoosh' }],
    render(grid, p, t) {
      const cx = DMD.cols / 2, cy = 11;
      dmdBlackHole(grid, cx, cy, t * 2, 1 + p * 0.5);
      // ring shockwave
      const rr = Math.round(p * 24);
      if (rr > 2) dmdCircle(grid, cx, cy, rr, ((t >> 1) & 1), false);
      dmdTextCentered(grid, 'EVENT HORIZON', 21, (t >> 3) & 1);
    },
  };
}
function animTeleporter() {
  return {
    dur: 150, sound: 'teleport',
    cues: [{ at: 70, snd: 'warp' }],
    render(grid, p, t) {
      // two portals; a ball jumps between them
      const lx = 26, rx = DMD.cols - 26, cy = 12;
      for (const px of [lx, rx]) {
        const ir = 4 + Math.round(Math.sin(t * 0.3 + px) * 1.5);
        dmdCircle(grid, px, cy, ir, 1, false);
      }
      const bx = lx + (rx - lx) * p;
      const by = cy - Math.sin(p * Math.PI) * 7;
      if (p > 0.08 && p < 0.92) dmdBall(grid, bx, by, 2);
      dmdTextCentered(grid, 'WORMHOLE JUMP', 20, (t >> 3) & 1);
    },
  };
}
function animHighScore(score) {
  return {
    dur: 200, sound: 'highscore',
    cues: [{ at: 30, snd: 'pop' }, { at: 90, snd: 'pop' }, { at: 150, snd: 'pop' }],
    render(grid, p, t) {
      dmdStars(grid, t, 9);
      // fireworks
      for (let f = 0; f < 3; f++) {
        const fcx = 22 + f * 32, fcy = 9;
        const burst = ((t - f * 30) % 90);
        if (burst >= 0 && burst < 24) {
          const rr = burst * 0.5;
          for (let i = 0; i < 8; i++) {
            const ang = i * (TAU / 8);
            dmdDot(grid, fcx + Math.cos(ang) * rr, fcy + Math.sin(ang) * rr * 0.7, 1);
          }
        }
      }
      dmdTextCentered(grid, 'HIGH SCORE', 16, 1);
      dmdTextCentered(grid, shortNum(score), 21, (t >> 3) & 1);
    },
  };
}
function animFreeGame(reason) {
  // reason: 'MATCH' or 'HIGH SCORE' or 'SPECIAL'
  return {
    dur: 170, sound: 'freegame',
    cues: [{ at: 20, snd: 'pop' }, { at: 80, snd: 'pop' }],
    render(grid, p, t) {
      dmdBox(grid, 8, 3, DMD.cols - 16, DMD.rows - 6, (t >> 2) & 1);
      dmdTextCentered(grid, 'FREE GAME', 8, 1);
      dmdTextCentered(grid, reason, 16, (t >> 3) & 1);
    },
  };
}
// the end-of-game MATCH sequence: digits spin then settle
function animMatch(playerDigit, matchDigit, won) {
  return {
    dur: 230, sound: 'matchroll',
    cues: won ? [{ at: 150, snd: 'pop' }] : [{ at: 150, snd: 'buzz' }],
    render(grid, p, t) {
      dmdTextCentered(grid, 'MATCH', 3, 1);
      // two big-ish digits; spin until ~frame 150 then lock
      const locked = t > 150;
      const dShow = locked ? matchDigit : (t % 10);
      const pShow = playerDigit;
      // draw player digit (left) and match digit (right) using glyph scale x2
      dmdDigitBig(grid, 34, 11, pShow);
      dmdDigitBig(grid, 60, 11, dShow);
      if (locked) {
        dmdTextCentered(grid, won ? 'MATCH - FREE GAME' : 'NO MATCH', 22, (t >> 3) & 1);
      }
    },
  };
}
// draw a digit at 2x scale
function dmdDigitBig(grid, x, y, d) {
  const g = GLYPHS[String(d)] || GLYPHS['0'];
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 5; c++)
      if (g[r][c] === '1') dmdRect(grid, x + c * 2, y + r * 2, 2, 2, 1);
}

/* ==========================================================================
 * SECTION 7d — TABLE-THEMED DMD ANIMATIONS
 * --------------------------------------------------------------------------
 * Each table has its own visual personality on the DMD. These small dot
 * sketches give each game a distinct identity. All are built from the same
 * primitives (dmdDot, dmdLine, dmdCircle, dmdRect, dmdBox, dmdText).
 * ========================================================================== */

// ---- BLEEB THE ALIEN (Cosmic Cluckers mascot) --------------------------
// A small 5-wide alien sprite. Draws him at (cx, cy) with optional wave arm.
function dmdBleeb(grid, cx, cy, wave) {
  // head (oval)
  dmdCircle(grid, cx, cy, 3, 1, true);
  // antenna
  dmdDot(grid, cx, cy - 4, 1);
  dmdDot(grid, cx, cy - 5, 1);
  // eyes (two dots, "off" inside head)
  dmdDot(grid, cx - 1, cy - 1, 0);
  dmdDot(grid, cx + 1, cy - 1, 0);
  // body
  dmdRect(grid, cx - 2, cy + 2, 5, 4, 1);
  // arms — left static, right waves
  dmdDot(grid, cx - 3, cy + 3, 1);
  if (wave) {
    dmdDot(grid, cx + 3, cy + 1, 1);
    dmdDot(grid, cx + 4, cy + 0, 1);
  } else {
    dmdDot(grid, cx + 3, cy + 3, 1);
  }
  // legs
  dmdDot(grid, cx - 1, cy + 6, 1); dmdDot(grid, cx + 1, cy + 6, 1);
}
function dmdChickenLeg(grid, cx, cy) {
  // a tiny drumstick shape
  dmdCircle(grid, cx, cy, 2, 1, true);
  dmdLine(grid, cx, cy + 1, cx + 3, cy + 4);
}
function dmdPlate(grid, cx, cy, w = 8) {
  // an oval plate
  for (let dx = -w; dx <= w; dx++) {
    const dy = Math.round(Math.sqrt(Math.max(0, 1 - (dx * dx) / (w * w))) * 2);
    dmdDot(grid, cx + dx, cy - dy, 1);
    dmdDot(grid, cx + dx, cy + dy, 1);
  }
  dmdLine(grid, cx - w, cy, cx + w, cy, 1);
}

function animOrderUp() {
  return {
    dur: 180, sound: 'orderUp',
    cues: [{ at: 80, snd: 'bell' }],
    render(grid, p, t) {
      // Bleeb at left, slides plate across to right
      dmdBleeb(grid, 16, 12, ((t >> 3) & 1));
      const plateX = 28 + Math.floor(p * 70);
      dmdPlate(grid, plateX, 13, 6);
      dmdChickenLeg(grid, plateX, 12);
      dmdTextCentered(grid, 'ORDER UP', 22, ((t >> 3) & 1));
    },
  };
}

// Used for the GORDON drops-in beat — silhouette pops into the doorway
function animBossVisit() {
  return {
    dur: 150, sound: 'doorBell',
    render(grid, p, t) {
      // door frame at right
      dmdBox(grid, 80, 4, 18, 22, 1);
      // boss silhouette appears
      const x = 88;
      const inside = Math.min(1, p * 2);
      if (inside > 0.2) {
        dmdRect(grid, x, 8, 4, 5, 1);      // head
        dmdRect(grid, x - 1, 13, 6, 8, 1); // body
      }
      // Bleeb panics at left
      dmdBleeb(grid, 14, 13, ((t >> 1) & 1));
      dmdTextCentered(grid, 'GORDON HERE', 24, ((t >> 3) & 1));
    },
  };
}

// Tips raining (a brief mode-start cutscene the engine doesn't run unless we
// call dmdPlay directly — left available for callers)
function animTipsRain() {
  return {
    dur: 150, sound: 'cashRegister',
    render(grid, p, t) {
      dmdTextCentered(grid, 'TIPS RAINING', 4, 1);
      // dollar signs fall
      for (let i = 0; i < 10; i++) {
        const x = (i * 11 + t * 0.3) % DMD.cols;
        const y = ((t * 0.4 + i * 5) % DMD.rows);
        dmdDot(grid, x | 0, y | 0, 1);
        dmdDot(grid, (x + 1) | 0, (y + 1) | 0, 1);
      }
      dmdBleeb(grid, DMD.cols / 2, 18, ((t >> 2) & 1));
    },
  };
}

// ---- SHOWER DEFENSE animations ----------------------------------------
function dmdBug(grid, cx, cy) {
  // body
  dmdCircle(grid, cx, cy, 2, 1, true);
  // legs
  dmdDot(grid, cx - 3, cy - 1, 1); dmdDot(grid, cx + 3, cy - 1, 1);
  dmdDot(grid, cx - 3, cy + 1, 1); dmdDot(grid, cx + 3, cy + 1, 1);
  // antennae
  dmdDot(grid, cx - 1, cy - 3, 1); dmdDot(grid, cx + 1, cy - 3, 1);
}
function dmdMoldSplat(grid, cx, cy, r) {
  for (let a = 0; a < TAU; a += TAU / 7) {
    const rr = r + ((a * 13) % 3);
    dmdDot(grid, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1);
  }
  dmdCircle(grid, cx, cy, r - 1, 1, true);
}

function animBugWave() {
  return {
    dur: 150, sound: 'bugSquish',
    render(grid, p, t) {
      dmdTextCentered(grid, 'BUGS CLEARED', 4, 1);
      // bugs scatter outward
      const n = 6;
      for (let i = 0; i < n; i++) {
        const ang = i * (TAU / n);
        const rr = p * 30;
        const bx = DMD.cols / 2 + Math.cos(ang) * rr;
        const by = 16 + Math.sin(ang) * rr * 0.5;
        if (p < 0.85) dmdBug(grid, bx | 0, by | 0);
      }
      if (p > 0.6) dmdTextCentered(grid, 'WAVE COMPLETE', 22, ((t >> 3) & 1));
    },
  };
}

function animMoldSplat() {
  return {
    dur: 160, sound: 'moldSplat',
    render(grid, p, t) {
      // splats appear progressively
      const spots = 5;
      for (let i = 0; i < spots; i++) {
        if (p * spots > i) {
          const x = 18 + i * 18;
          const y = 12;
          dmdMoldSplat(grid, x, y, 2 + ((t >> 2) % 2));
        }
      }
      dmdTextCentered(grid, 'MOLD KILLED', 22, 1);
    },
  };
}

function animShowerOn() {
  return {
    dur: 150, sound: 'showerOn',
    render(grid, p, t) {
      // showerhead at top
      dmdRect(grid, DMD.cols / 2 - 6, 2, 12, 3, 1);
      // water beams falling
      for (let i = -5; i <= 5; i++) {
        const x = DMD.cols / 2 + i * 2;
        const len = Math.min(20, p * 28 + ((t + i) & 3));
        for (let y = 5; y < 5 + len; y += 2) dmdDot(grid, x | 0, y | 0, 1);
      }
      if (p > 0.4) dmdTextCentered(grid, 'SHOWER ON', 22, ((t >> 3) & 1));
    },
  };
}

function animDrainBeast() {
  return {
    dur: 180, sound: 'drainBeast',
    cues: [{ at: 90, snd: 'beastRoar' }],
    render(grid, p, t) {
      // a giant eye opens
      const cx = DMD.cols / 2, cy = 13;
      const eyeW = Math.round(8 + p * 16);
      dmdCircle(grid, cx, cy, eyeW, 1, false);
      const pupil = Math.max(2, Math.round((1 - p) * eyeW * 0.6));
      dmdCircle(grid, cx, cy, pupil, 1, true);
      dmdTextCentered(grid, 'DRAIN BEAST', 24, ((t >> 3) & 1));
    },
  };
}

// ---- INITIALS ENTRY -----------------------------------------------------
const INITIALS_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.<';  // < = back/end
function animInitialsEntry() {
  // not time-bounded — render reads live _pb.initials state
  return {
    dur: 999999, loop: true, sound: 'highscore',
    render(grid, p, t) {
      const st = _pb.initials;
      dmdTextCentered(grid, 'HIGH SCORE', 2, 1);
      dmdTextCentered(grid, 'ENTER INITIALS', 9, 1);
      // three slots
      const slotW = 8, gap = 4, total = 3 * slotW + 2 * gap;
      const sx = Math.floor((DMD.cols - total) / 2);
      for (let i = 0; i < 3; i++) {
        const cx = sx + i * (slotW + gap);
        const ch = _pb.initials.letters[i] || ' ';
        dmdText(grid, ch, cx + 1, 16, 1);
        if (i === st.slot) {
          // blinking underline cursor on the active slot
          if ((t >> 3) & 1) for (let c = 0; c < 6; c++) dmdDot(grid, cx + c, 24, 1);
        } else {
          for (let c = 0; c < 6; c++) dmdDot(grid, cx + c, 24, 1);
        }
      }
    },
  };
}

// ---- ATTRACT REEL (~30s loop) ------------------------------------------
/* The attract reel is one long looping animation made of timed segments:
 *   0.0 -  6s  title build with black-hole motif
 *   6s - 10s  tagline / "a quantum pinball adventure"
 *  10s - 22s  high-score table (scrolls through entries)
 *  22s - 27s  "how to play" flash
 *  27s - 30s  big "PRESS LAUNCH" call to action, then loop
 */
function animAttractReel(table) {
  const FPS = 60;
  const SEGS = [
    { len: 6 * FPS, draw: attractTitle },
    { len: 4 * FPS, draw: attractTagline },
    { len: 12 * FPS, draw: attractScores },
    { len: 5 * FPS, draw: attractHowTo },
    { len: 3 * FPS, draw: attractPressLaunch },
  ];
  const total = SEGS.reduce((s, x) => s + x.len, 0);
  return {
    dur: total, loop: true, sound: 'attractStart',
    cues: [{ at: 1, snd: 'attractStart' }],
    render(grid, p, t) {
      let acc = 0;
      for (const seg of SEGS) {
        if (t < acc + seg.len) {
          seg.draw(grid, (t - acc) / seg.len, t, table);
          return;
        }
        acc += seg.len;
      }
      attractPressLaunch(grid, 0.5, t, table);
    },
  };
}
function attractTitle(grid, p, t, table) {
  dmdStars(grid, t, 2);
  dmdBlackHole(grid, DMD.cols / 2, 11, t * 1.5, 1);
  const name = table.name.toUpperCase().substring(0, 16);
  // letters drop in one at a time
  const w = dmdTextWidth(name);
  const sx = Math.floor((DMD.cols - w) / 2);
  const shown = Math.min(name.length, Math.floor(p * name.length * 1.6));
  for (let i = 0; i < shown; i++) {
    dmdText(grid, name[i], sx + i * 6, 17, 1);
  }
}
function attractTagline(grid, p, t, table) {
  dmdStars(grid, t, 4);
  const sub = (table.subtitle || 'QUANTUM PINBALL').toUpperCase();
  // typewriter reveal
  const shown = Math.min(sub.length, Math.floor(p * sub.length * 1.5));
  dmdTextCentered(grid, sub.substring(0, shown), 8, 1);
  if (p > 0.6) dmdTextCentered(grid, 'BEND SPACE - WIN BIG', 16, (t >> 3) & 1);
}
function attractScores(grid, p, t, table) {
  dmdTextCentered(grid, 'BEST PHYSICISTS', 2, 1);
  const tbl = loadHighTable(table.id);
  // show 5 rows, slow vertical scroll through them
  const rowH = 8;
  const startY = 11 - Math.floor((p * tbl.length * rowH)) % (tbl.length * rowH);
  for (let i = 0; i < tbl.length; i++) {
    const y = startY + i * rowH;
    // clip BELOW the header (row 2-8) and within the grid
    if (y < 11 || y > DMD.rows - 8) continue;
    const e = tbl[i];
    dmdText(grid, (i + 1) + '.' + e.name, 6, y, 1);
    const sc = shortNum(e.score);
    dmdText(grid, sc, DMD.cols - dmdTextWidth(sc) - 6, y, 1);
  }
}
function attractHowTo(grid, p, t) {
  dmdTextCentered(grid, 'FLIPPERS - L / R', 4, 1);
  dmdTextCentered(grid, 'HOLD LAUNCH', 12, 1);
  dmdTextCentered(grid, 'TO CHARGE PLUNGER', 19, (t >> 3) & 1);
}
function attractPressLaunch(grid, p, t, table) {
  dmdStars(grid, t, 6);
  dmdTextCentered(grid, (table ? table.name.toUpperCase() : 'PINBALL').substring(0, 16), 4, 1);
  dmdBox(grid, 22, 12, DMD.cols - 44, 11, 1);
  dmdTextCentered(grid, 'PRESS LAUNCH', 15, (t >> 3) & 1);
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
    prevAngle: opt.rest,            // angle at start of frame (for swept collision)
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
  // single segment at the CURRENT angle (used for rendering / simple queries)
  const tip = flipperTip(fl);
  return seg(fl.px, fl.py, tip.x, tip.y, { r: fl.r, role: 'flipper', bounce: 0.5, ref: fl });
}
/* Swept flipper colliders: a flipper can sweep several ball-widths in one
 * frame, so a single frozen segment lets a fast-swinging flipper pass right
 * through the ball (tunneling, worst at the tip). Instead we emit a fan of
 * interpolated segments spanning prevAngle..angle, so the ball's swept test
 * meets the flipper wherever the arc crosses it. All share the same `ref`,
 * so momentum transfer in respondCollision is unchanged. */
function flipperSweptColliders(fl, out) {
  const a0 = fl.prevAngle, a1 = fl.angle;
  const arc = Math.abs(a1 - a0);
  // tip travel in pixels = arc * len ; one sub-segment per ~half ball radius
  const steps = Math.max(1, Math.min(10, Math.ceil((arc * fl.len) / (PB.BALL_R * 0.5))));
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    const tx = fl.px + Math.cos(a) * fl.len;
    const ty = fl.py + Math.sin(a) * fl.len;
    out.push(seg(fl.px, fl.py, tx, ty,
      { r: fl.r, role: 'flipper', bounce: 0.5, ref: fl }));
  }
}
function updateFlipper(fl) {
  const target = fl.up ? fl.active : fl.rest;
  const prev = fl.angle;
  fl.prevAngle = prev;             // remember where the flipper was this frame
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
    teleHoles: null,      // timed open/close teleport holes
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

  /* ---- timed teleport holes (mechanical, always visible) ---- */
  // Four holes that open and close on a progression-linked schedule. When
  // open, a ball entering the hole is captured briefly, then ejected from
  // a random OTHER open hole — including the "unreachable pocket" (hole 3)
  // which is behind a wall section only a teleport can reach.
  T.teleHoles = [
    { id: 0, x: 80,  y: 180, r: 16, label: 'A', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 50, iris: 0 },
    { id: 1, x: 460, y: 480, r: 16, label: 'B', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 50, iris: 0 },
    { id: 2, x: 270, y: 650, r: 16, label: 'C', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 50, iris: 0 },
    // hole D is in a walled-off pocket — unreachable except by teleport
    { id: 3, x: 420, y: 130, r: 16, label: 'D', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 50, iris: 0, secret: true },
  ];
  // small wall enclosing the "secret" pocket so the ball can only arrive via teleport
  T.staticColliders.push(
    seg(400, 115, 440, 115, { r:3, role:'wall', color:T.colors.wall }),  // top
    seg(400, 115, 400, 148, { r:3, role:'wall', color:T.colors.wall }),  // left
    seg(440, 115, 440, 148, { r:3, role:'wall', color:T.colors.wall }),  // right
    // bottom has a small gap so the ball eventually rolls out after eject
    seg(400, 148, 413, 148, { r:3, role:'wall', color:T.colors.wall }),
    seg(427, 148, 440, 148, { r:3, role:'wall', color:T.colors.wall }),
  );

  /* ---- top rollover lanes (skill-shot style) ---- */
  T.lanes.push(
    { x: 175, y: 86, lit: false }, { x: 270, y: 78, lit: false }, { x: 365, y: 86, lit: false },
  );

  /* ---- table-systems data (consumed by SECTION 15b engines) ----------- */
  // shot sequence — 5 lit shots that cycle. Player must hit them in order.
  T.shotSequence = [
    { id: 'left_orbit',    label: 'HIT LEFT ORBIT',    matchType: 'ramp',     matchId: 'left_orbit' },
    { id: 'upper_wormhole_l', label: 'HIT NW WORMHOLE', matchType: 'wormhole', matchId: 0 },
    { id: 'center_loop',   label: 'HIT CENTER LOOP',   matchType: 'ramp',     matchId: 'center_loop' },
    { id: 'upper_wormhole_r', label: 'HIT NE WORMHOLE', matchType: 'wormhole', matchId: 1 },
    { id: 'lock',          label: 'HIT LOCK FOR JUMP', matchType: 'lock',     matchId: null },
  ];
  T.shotReward = 5000;
  T.shotCompleteBonus = 25000;

  // modes — short scoring frenzies triggered by milestones
  T.modeDefs = {
    wormholeRush: {
      label: 'WORMHOLE RUSH', dur: 1200, mult: 3,
      hookType: 'wormhole', storyStart: 'BEND SPACE NOW',
    },
    bumperFrenzy: {
      label: 'BUMPER FRENZY', dur: 900, mult: 5,
      hookType: 'bumper', storyStart: 'PARTICLE STORM',
    },
  };
  T.modeTriggers = {
    shotSequenceComplete: 'wormholeRush',
    bigCombo: 'bumperFrenzy',
  };

  // story beats — DMD flashes at narrative moments
  T.storyBeats = {
    gameStart:     'ALIGN THE WORMHOLES',
    twoWormholes:  'GRAVITY DISTORTS',
    fourWormholes: 'PREPARE FOR JUMP',
    multiball:     'QUANTUM ENTANGLEMENT',
    extraBall:     'BONUS DIMENSION',
    victory:       'YOU HAVE BENT SPACE',
  };

  // extra-ball score thresholds
  T.extraBallScoreThresholds = [50000, 150000];

  // table-specific bank-completion handler (engine calls this generically)
  T.onBankComplete = function(group, T) {
    if (group === 'worm') {
      T.wormProgress++;
      activateWormHole(T);
      dmdPlay(animBlackHole());
      addScore(3000 * _pb.mult);
    } else if (group === 'hole') {
      T.holeProgress++;
      activateWormHole(T);
      dmdPlay(animBlackHole());
      addScore(3000 * _pb.mult);
    }
  };

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
 * SECTION 10b — SHARED TABLE FRAME
 * --------------------------------------------------------------------------
 * All three tables share the same playfield dimensions, plunger location,
 * and flipper pivot positions. This helper builds the common cabinet frame
 * (walls, plunger lane, slingshots, return rails, main + mid flippers) so
 * each unique table builder only has to add its theme-specific elements.
 *
 * Returns a base table object with the cabinet pre-built. Callers add:
 *   bumpers, targets, ramps, wormholes, lanes, lockZone, teleHoles,
 *   table-systems data (shotSequence, modeDefs, storyBeats, ...),
 *   plus T.onBankComplete and any custom decor.
 * ========================================================================== */
function makeBaseTable(id, tdef, defaults) {
  const T = {
    id,
    name: tdef?.name || defaults.name,
    subtitle: tdef?.subtitle || defaults.subtitle,
    colors: tdef?.colors || defaults.colors,
    staticColliders: [],
    flippers: [],
    bumpers: [],
    targets: [],
    ramps: [],
    wormholes: [],       // many tables won't use this, leave empty
    posts: [],
    lanes: [],
    spinners: [],
    lockZone: null,
    teleHoles: null,
    // generic logic state
    activeHoles: 0,
    multiballArmed: false,
    locked: 0,
    // upper-deck decor items: drawn after ramps so they read as "under glass"
    upperDeck: [],
    // bonus animated decor (e.g. shower spray, neon sign blink)
    decor: [],
  };

  /* ---- outer walls (cabinet boundary) ---- */
  const W = WALL;
  const laneX = PB.W - 46;
  const laneWallL = PB.W - 70;
  const laneTop = 210;
  T.staticColliders.push(
    // outer top
    seg(W.L, W.T, 200, W.T, { r:4, role:'wall', color:T.colors.wall }),
    seg(340, W.T, W.R, W.T, { r:4, role:'wall', color:T.colors.wall }),
    // angled top-left
    seg(W.L, W.T, W.L, 200, { r:4, role:'wall', color:T.colors.wall }),
    seg(W.L, 200, 26, 220, { r:4, role:'wall', color:T.colors.wall }),
    // left wall + outlane
    seg(W.L, 220, W.L, 760, { r:4, role:'wall', color:T.colors.wall }),
    seg(W.L, 760, 70, 870, { r:4, role:'wall', color:T.colors.wall }),
    // right side & plunger lane
    seg(W.R, W.T, W.R, 900, { r:4, role:'wall', color:T.colors.wall }),
    seg(laneWallL, laneTop, laneWallL, 900, { r:4, role:'wall', color:T.colors.wall }),
    seg(laneWallL, 900, 470, 850, { r:4, role:'wall', color:T.colors.wall }),
  );
  // top-right hood (curved deflector + scripted feed handle this same as Worm Holer)
  T.staticColliders.push(
    seg(360, 26, 440, 46, { r:4, role:'wall', color:T.colors.wall }),
    seg(440, 46, 488, 120, { r:4, role:'wall', color:T.colors.wall }),
    seg(488, 120, 470, 196, { r:4, role:'wall', color:T.colors.wall }),
    seg(470, 196, 372, 250, { r:4, role:'wall', color:T.colors.wall }),
    seg(514, 206, 476, 180, { r:4, role:'wall', color:T.colors.wall }),
  );
  T.laneGate = seg(470, 216, 514, 202, { r:4, role:'gate', color:T.colors.wall, active:true });

  /* ---- plunger ---- */
  T.plunger = {
    x: laneX, top: 900, bottom: 944, headRest: 920, headDeep: 940,
    headY: 920,
  };

  /* ---- main flippers (identical pivot geometry across all tables) ---- */
  T.flippers.push(
    makeFlipper({ side:'L', group:'main', px:176, py:812, len:84, r:9,
      rest: 0.50, active: 0.50 - 0.95, speed: 0.62 }),
    makeFlipper({ side:'R', group:'main', px:364, py:812, len:84, r:9,
      rest: Math.PI - 0.50, active: Math.PI - 0.50 + 0.95, speed: 0.62 }),
  );

  /* ---- slingshots ---- */
  T.staticColliders.push(
    seg(96, 690, 150, 790, { r:6, role:'sling', bounce:1.5, color:T.colors.neon }),
    seg(444, 690, 390, 790, { r:6, role:'sling', bounce:1.5, color:T.colors.neon }),
  );
  T.posts.push(
    circle(96, 690, 8, { role:'post', color:T.colors.wall }),
    circle(444, 690, 8, { role:'post', color:T.colors.wall }),
  );
  // inlane rails to flipper pivots
  T.staticColliders.push(
    seg(150, 790, 176, 812, { r:3, role:'wall', color:T.colors.wall }),
    seg(390, 790, 364, 812, { r:3, role:'wall', color:T.colors.wall }),
  );

  return T;
}

/* ==========================================================================
 * SECTION 10c — TABLE: COSMIC CLUCKERS
 * --------------------------------------------------------------------------
 * Theme: 80s sitcom parody. BLEEB, a green alien chef, runs an Earth chicken
 * restaurant. The playfield IS the restaurant — dining floor below, an
 * upper booth deck reachable via ramps, kitchen pass with grill bumpers,
 * and the FRYER lock zone for the multiball "fryer overflow".
 *
 * Unique mechanics:
 *   - UPPER DECK: real Z-axis ramps lift the ball over decorative booths
 *     drawn below the ramps. Booth circles are rollover-style targets the
 *     ball triggers when delivered from above.
 *   - ORDER drop-target bank (5 letters) advances customer service.
 *   - TIPS drop-target bank (4 letters) awards jackpots.
 *   - GRILL bumpers fire sizzle sounds and accelerate during BUMPER FRENZY.
 *   - Story beats narrate Bleeb running the diner.
 * ========================================================================== */
function buildCosmicCluckers(tdef) {
  const T = makeBaseTable('cosmic_cluckers', tdef, {
    name: 'COSMIC CLUCKERS',
    subtitle: "Bleeb's Diner",
    colors: { bg:'#2a1408', mid:'#5e2a14', neon:'#ffb330', neon2:'#6dd44a',
              wall:'#9b5a2c', decor:'#ff5a4c' },
  });

  /* ---- GRILL BUMPERS (3, fan cluster, mid-table) ---- */
  // These are the diner's grill burners — they pop with sizzle when hit.
  const grillDefs = [
    { x: 200, y: 410, r: 26 },   // left burner
    { x: 320, y: 410, r: 26 },   // right burner
    { x: 260, y: 318, r: 26 },   // back burner
  ];
  for (const bd of grillDefs) {
    T.bumpers.push({ x: bd.x, y: bd.y, r: bd.r, cooldown:0, flash:0, value: 300, role:'grill' });
  }

  /* ---- ORDER bank (5 horizontal drop targets, lower mid) ---- */
  const orderBank = makeTargetBank({
    word: 'ORDER', x: 116, y: 600, dx: 62, dy: 0, w: 38, h: 28,
    vertical: false, group: 'order', value: 600,
  });
  T.targets.push(...orderBank);

  /* ---- TIPS bank (4 vertical drop targets, right side) ---- */
  const tipsBank = makeTargetBank({
    word: 'TIPS', x: 96, y: 230, dx: 0, dy: 36, w: 30, h: 30,
    vertical: true, group: 'tips', value: 700,
  });
  T.targets.push(...tipsBank);

  /* ---- UPPER DECK BOOTHS (rollover circles, drawn through translucent ramp) ---- */
  // Four booths in the upper deck — when the ball is delivered up here via
  // a ramp it passes over them and counts as "serving customers".
  T.upperDeck = [
    { kind: 'booth', x: 180, y: 200, r: 18, label: '1', served: false, flash: 0 },
    { kind: 'booth', x: 250, y: 170, r: 18, label: '2', served: false, flash: 0 },
    { kind: 'booth', x: 320, y: 170, r: 18, label: '3', served: false, flash: 0 },
    { kind: 'booth', x: 390, y: 200, r: 18, label: '4', served: false, flash: 0 },
    // Decorative neon sign + plant
    { kind: 'sign', x: 270, y: 90, w: 220, h: 28, text: "BLEEB'S", blink: 0 },
    { kind: 'plant', x: 80, y: 110, r: 14 },
  ];

  /* ---- LOCK ZONE — THE FRYER (top center) ---- */
  T.lockZone = { x: 270, y: 130, r: 22, active: true, label: 'FRYER' };

  /* ---- RAMPS (two distinct ramps to the upper deck) ---- */
  // KITCHEN RAMP — left side, climbs over the booths, ejects right inlane
  T.ramps.push(makeRamp({
    id: 'kitchen_ramp',
    path: [
      { x: 110, y: 640 }, { x: 90, y: 520 }, { x: 110, y: 380 },
      { x: 170, y: 260 }, { x: 270, y: 180 }, { x: 380, y: 230 },
      { x: 430, y: 360 }, { x: 430, y: 500 }, { x: 420, y: 640 },
    ],
    width: 30, h0: 0, h1: 64, exitBoost: 7, mountSpeed: 7,
    color: T.colors.neon,
  }));
  // BOOTH RAMP — shorter center ramp lifting ball briefly over the booths
  T.ramps.push(makeRamp({
    id: 'booth_ramp',
    path: [
      { x: 260, y: 540 }, { x: 260, y: 460 }, { x: 230, y: 400 },
      { x: 260, y: 340 }, { x: 300, y: 320 },
    ],
    width: 28, h0: 0, h1: 44, exitBoost: 6, mountSpeed: 6.5,
    color: T.colors.neon2,
  }));

  /* ---- MID-TABLE MINI FLIPPERS (kickers below grill) ---- */
  T.flippers.push(
    makeFlipper({ side:'L', group:'mid', px:150, py:560, len:54, r:8,
      rest: 0.45, active: 0.45 - 0.85, speed: 0.7 }),
    makeFlipper({ side:'R', group:'mid', px:390, py:560, len:54, r:8,
      rest: Math.PI - 0.45, active: Math.PI - 0.45 + 0.85, speed: 0.7 }),
  );

  /* ---- ROLLOVER LANES (top) - "ABC" lanes spell out specials of the day ---- */
  T.lanes.push(
    { x: 175, y: 86, lit: false, label: 'S' },
    { x: 270, y: 78, lit: false, label: 'O' },
    { x: 365, y: 86, lit: false, label: 'D' },  // SOD = special of day
  );

  /* ---- TIMED HOLE (just one — the back door) -------------------------- */
  T.teleHoles = [
    { id: 0, x: 75, y: 410, r: 14, label: 'BACK', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 40, iris: 0 },
  ];

  // game state
  T.orderProgress = 0;     // ORDERs completed
  T.tipsProgress = 0;
  T.boothsServed = 0;
  T.shotsTakenThisGame = 0;

  /* ---- TABLE-SYSTEMS DATA (consumed by the engine) -------------------- */
  T.shotSequence = [
    { id: 'kitchen_ramp', label: 'TO THE KITCHEN', matchType: 'ramp', matchId: 'kitchen_ramp' },
    { id: 'booth_ramp',   label: 'TO BOOTH ROW',   matchType: 'ramp', matchId: 'booth_ramp' },
    { id: 'lock',         label: 'INTO THE FRYER', matchType: 'lock', matchId: null },
    { id: 'kitchen_ramp_2', label: 'BACK TO KITCHEN', matchType: 'ramp', matchId: 'kitchen_ramp' },
  ];
  T.shotReward = 4000;
  T.shotCompleteBonus = 22000;

  T.modeDefs = {
    grillFrenzy: {
      label: 'GRILL FRENZY', dur: 900, mult: 5,
      hookType: 'bumper', storyStart: 'WOK ON FIRE',
    },
    tipsRaining: {
      label: 'TIPS RAINING', dur: 1100, mult: 3,
      hookType: 'ramp', storyStart: 'CASH POURS DOWN',
    },
  };
  T.modeTriggers = {
    shotSequenceComplete: 'tipsRaining',
    bigCombo: 'grillFrenzy',
  };

  T.storyBeats = {
    gameStart:    'OPEN THE DINER',
    firstOrder:   'ORDER UP',
    fryerLit:     'FRYER IS HOT',
    bossVisit:    'GORDON DROPS IN',     // sitcom boss trope
    catchPhrase:  'ZORPLAX SAYS HI',     // Bleeb's catchphrase
    multiball:    'CUSTOMERS RUSH IN',
    extraBall:    'BLEEB WINKS',
    victory:      'EMPLOYEE OF MONTH',
  };

  T.extraBallScoreThresholds = [45000, 130000];

  // Bank completion handler — sitcom plot beats fire here
  T.onBankComplete = function(group, T) {
    if (group === 'order') {
      T.orderProgress++;
      addScore(3500 * _pb.mult);
      dmdPlay(animOrderUp());
      // first ORDER bank completed = first plot beat
      if (T.orderProgress === 1) storyBeat('firstOrder', T);
      // every 3rd ORDER = boss-visit gag
      if (T.orderProgress % 3 === 0) storyBeatRepeatable('bossVisit', T);
      // light the fryer for multiball when 2 ORDERs done
      if (T.orderProgress >= 2 && !T.multiballArmed) {
        T.multiballArmed = true;
        storyBeat('fryerLit', T);
      }
    } else if (group === 'tips') {
      T.tipsProgress++;
      addScore(5000 * _pb.mult);
      dmdFlash('TIPS COMPLETE', '+' + (5000 * _pb.mult));
      // tips bank fires Bleeb's catchphrase every 2 completions
      if (T.tipsProgress % 2 === 0) storyBeatRepeatable('catchPhrase', T);
    }
  };

  return T;
}

/* ==========================================================================
 * SECTION 10d — TABLE: SHOWER DEFENSE
 * --------------------------------------------------------------------------
 * Theme: tower-defense parody set in a bathroom. The player defends against
 * waves of bugs and mold using bathroom-fixture pinball elements. The
 * SHOWER toggle is the table's signature mechanic: when ON, a water curtain
 * activates a one-way deflector at the top that redirects the ball into a
 * scoring funnel; when OFF, the same path is wide open but no shower bonus.
 *
 * Unique mechanics:
 *   - SHOWER TOGGLE: rollover lit shower lanes flip the shower on/off.
 *     ON = water-curtain segment is active in physics, deflecting the ball.
 *   - BUGS bank (4) and MOLD bank (4) - sequential waves. Defeat BUGS to
 *     trigger MOLD, defeat MOLD to spawn the DRAIN BEAST (lock).
 *   - SINK FAUCETS as bumpers (HOT + COLD, 2 instead of 3).
 *   - The TOILET drain is the multiball lock zone.
 * ========================================================================== */
function buildShowerDefense(tdef) {
  const T = makeBaseTable('shower_defense', tdef, {
    name: 'SHOWER DEFENSE',
    subtitle: 'Tower Defense Parody',
    colors: { bg:'#031820', mid:'#0a3848', neon:'#2ee8e8', neon2:'#7ec8ff',
              wall:'#3f7f8a', decor:'#a8e8e8' },
  });

  /* ---- SINK FAUCETS (2 bumpers — HOT/COLD) ---- */
  T.bumpers.push(
    { x: 200, y: 430, r: 28, cooldown:0, flash:0, value: 350, role:'hot',  label:'H' },
    { x: 340, y: 430, r: 28, cooldown:0, flash:0, value: 350, role:'cold', label:'C' },
  );
  // Sink basin (decorative collider — also acts as a small wall arc)
  T.staticColliders.push(
    seg(160, 480, 380, 480, { r:4, role:'wall', color:T.colors.wall }),
  );

  /* ---- BUGS bank (4 horizontal targets — first wave) ---- */
  const bugsBank = makeTargetBank({
    word: 'BUGS', x: 130, y: 620, dx: 60, dy: 0, w: 38, h: 28,
    vertical: false, group: 'bugs', value: 600,
  });
  T.targets.push(...bugsBank);

  /* ---- MOLD bank (4 vertical targets, left side — second wave) ---- */
  const moldBank = makeTargetBank({
    word: 'MOLD', x: 78, y: 260, dx: 0, dy: 36, w: 30, h: 30,
    vertical: true, group: 'mold', value: 800,
  });
  T.targets.push(...moldBank);

  /* ---- TOILET LOCK ZONE (top center — multiball drain beast) ---- */
  T.lockZone = { x: 270, y: 140, r: 22, active: true, label: 'TOILET' };

  /* ---- SHOWER STALL (decorative + the shower-toggle mechanic) --------- */
  T.shower = {
    on: false,             // toggled by rollover lanes
    spray: 0,              // animation phase
    headX: 132, headY: 90, // showerhead position
    curtainY: 220,         // where the water curtain hits
  };
  // when ON, this collider becomes active and deflects balls leftward into MOLD bank
  T.showerCurtain = seg(120, 100, 200, 240,
    { r:3, role:'wall', color:T.colors.neon, active: false });
  T.staticColliders.push(T.showerCurtain);

  /* ---- RAMPS (real Z-axis) -------------------------------------------- */
  // DRAIN RAMP — climbs from left sling around to the shower, ejects from showerhead
  T.ramps.push(makeRamp({
    id: 'drain_ramp',
    path: [
      { x: 110, y: 640 }, { x: 86, y: 500 }, { x: 110, y: 360 },
      { x: 180, y: 260 }, { x: 270, y: 200 }, { x: 360, y: 220 },
      { x: 420, y: 320 }, { x: 430, y: 480 }, { x: 420, y: 640 },
    ],
    width: 30, h0: 0, h1: 64, exitBoost: 7, mountSpeed: 7,
    color: T.colors.neon,
  }));
  // LOOFAH RAMP — short center scrubber loop
  T.ramps.push(makeRamp({
    id: 'loofah_ramp',
    path: [
      { x: 270, y: 520 }, { x: 270, y: 430 }, { x: 240, y: 380 },
      { x: 270, y: 320 }, { x: 310, y: 310 },
    ],
    width: 28, h0: 0, h1: 44, exitBoost: 6, mountSpeed: 6.5,
    color: T.colors.neon2,
  }));

  /* ---- MID-TABLE MINI FLIPPERS (under sink) --------------------------- */
  T.flippers.push(
    makeFlipper({ side:'L', group:'mid', px:150, py:540, len:54, r:8,
      rest: 0.45, active: 0.45 - 0.85, speed: 0.7 }),
    makeFlipper({ side:'R', group:'mid', px:390, py:540, len:54, r:8,
      rest: Math.PI - 0.45, active: Math.PI - 0.45 + 0.85, speed: 0.7 }),
  );

  /* ---- ROLLOVER LANES (top) — SHOWER toggle lanes --------------------- */
  // Hitting all three lights the shower; subsequent completion toggles it.
  T.lanes.push(
    { x: 175, y: 86, lit: false, label: 'S' },
    { x: 270, y: 78, lit: false, label: 'O' },
    { x: 365, y: 86, lit: false, label: 'N' },  // S-O-N = SHOWER ON
  );

  /* ---- TIMED HOLES — DRAIN PIPES on either side ----------------------- */
  T.teleHoles = [
    { id: 0, x: 60,  y: 380, r: 14, label: 'L', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 40, iris: 0 },
    { id: 1, x: 480, y: 380, r: 14, label: 'R', open: false, timer: 0,
      capturedBall: null, captureTimer: 0, holdFrames: 40, iris: 0 },
  ];

  // game state
  T.wave = 1;              // 1=BUGS, 2=MOLD, 3=DRAIN BEAST
  T.bugsKilled = 0;
  T.moldKilled = 0;
  T.beastHits = 0;

  /* ---- TABLE-SYSTEMS DATA -------------------------------------------- */
  T.shotSequence = [
    { id: 'drain_ramp',  label: 'HIT THE DRAIN',   matchType: 'ramp', matchId: 'drain_ramp' },
    { id: 'loofah_ramp', label: 'SCRUB THE LOOFAH',matchType: 'ramp', matchId: 'loofah_ramp' },
    { id: 'lock',        label: 'FLUSH THE TOILET',matchType: 'lock', matchId: null },
    { id: 'drain_ramp_2',label: 'DRAIN AGAIN',     matchType: 'ramp', matchId: 'drain_ramp' },
  ];
  T.shotReward = 4500;
  T.shotCompleteBonus = 24000;

  T.modeDefs = {
    moldWave: {
      label: 'MOLD WAVE', dur: 1000, mult: 4,
      hookType: 'bumper', storyStart: 'SCRUB FASTER',
    },
    steamCycle: {
      label: 'STEAM CYCLE', dur: 1200, mult: 2,
      hookType: 'ramp', storyStart: 'STEAM EVERYWHERE',
    },
  };
  T.modeTriggers = {
    shotSequenceComplete: 'steamCycle',
    bigCombo: 'moldWave',
  };

  T.storyBeats = {
    gameStart:    'PROTECT THE BATH',
    bugsCleared:  'BUGS WIPED OUT',
    moldArrives:  'MOLD ADVANCING',
    moldCleared:  'BLEACH VICTORIOUS',
    drainBeast:   'DRAIN BEAST RISES',
    showerOn:     'WATER FORCE LIVE',
    multiball:    'EVERY DRAIN ALIVE',
    extraBall:    'BAR OF SOAP BONUS',
    victory:      'SPOTLESS CHAMPION',
  };

  T.extraBallScoreThresholds = [40000, 120000];

  T.onBankComplete = function(group, T) {
    if (group === 'bugs') {
      T.bugsKilled++;
      addScore(3500 * _pb.mult);
      dmdPlay(animBugWave());
      if (T.wave === 1) {
        storyBeat('bugsCleared', T);
        T.wave = 2;
        storyBeat('moldArrives', T);
      }
    } else if (group === 'mold') {
      T.moldKilled++;
      addScore(4500 * _pb.mult);
      dmdPlay(animMoldSplat());
      if (T.wave === 2) {
        storyBeat('moldCleared', T);
        T.wave = 3;
        T.multiballArmed = true;
        storyBeat('drainBeast', T);
      }
    }
  };

  // Shower-toggle hook called from the lane-rollover code below
  T.onLanesComplete = function(T) {
    T.shower.on = !T.shower.on;
    T.showerCurtain.active = T.shower.on;
    if (T.shower.on) {
      storyBeatRepeatable('showerOn', T);
      dmdPlay(animShowerOn());
    } else {
      dmdFlash('SHOWER OFF');
    }
    snd('shower');
  };

  return T;
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
  // flippers — emit a swept fan of segments across this frame's arc so a
  // fast swing cannot tunnel through the ball
  for (const fl of T.flippers) flipperSweptColliders(fl, list);
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
    // table-systems hooks
    onShotEvent('ramp', ramp.id, _table);
    onComboRamp(ramp.id, _table);
    addScore(1500 * modeMult('ramp') * _pb.mult);
    checkExtraBallScoreThresholds(_table);
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
  if (ball._captured) return;   // held inside a teleport hole

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
      // a rising flipper that has swept INTO a resting ball should still
      // flick it — the swept-segment test can miss a near-stationary ball,
      // so impart the flipper's surface velocity + punch here as a fallback.
      if (col.role === 'flipper') {
        const fl = col.ref;
        if (fl.up && Math.abs(fl.av) > 0.05 && ball.flipHitFrame !== _pb.tick) {
          ball.flipHitFrame = _pb.tick;
          const armX = ball.x - fl.px, armY = ball.y - fl.py;
          ball.vx += -armY * fl.av * 1.15;
          ball.vy +=  armX * fl.av * 1.15;
          const armLen = clamp(Math.hypot(armX, armY) / fl.len, 0, 1);
          const punch = 4 + armLen * 5;
          ball.vx += push.nx * punch;
          ball.vy += push.ny * punch;
          snd('flipper');
        }
      }
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
        addScore(2500); _pb.mult++;
        // call table-specific lanes-complete handler if provided (e.g. shower toggle)
        if (T.onLanesComplete) T.onLanesComplete(T);
        else dmdFlash('LANES COMPLETE', 'MULTIPLIER UP');
        snd('group');
      }
    }
  }

  /* --- upper-deck booths (only counted when ball is on a ramp above) --- */
  if (T.upperDeck && ball.onRamp && ball.z > 30) {
    for (const u of T.upperDeck) {
      if (u.kind !== 'booth' || u.served) continue;
      if (dist(ball.x, ball.y, u.x, u.y) < u.r + ball.r) {
        u.served = true; u.flash = 30;
        T.boothsServed = (T.boothsServed || 0) + 1;
        addScore(2500 * _pb.mult);
        dmdFlash('TABLE ' + u.label + ' SERVED', '+' + (2500 * _pb.mult));
        snd('orderUp');
        // all booths served = jackpot
        if (T.upperDeck.filter(x => x.kind === 'booth').every(x => x.served)) {
          addScore(15000 * _pb.mult);
          dmdFlash('ALL TABLES SERVED', '+15000');
          // reset for next round
          setTimeout(() => {
            T.upperDeck.forEach(x => { if (x.kind === 'booth') x.served = false; });
          }, 1500);
        }
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

  /* --- hard containment backstop ---------------------------------------
   * Swept collision plus depenetration handles essentially every case, but
   * an extreme-speed ball striking a corner at a glancing angle can, very
   * rarely, slip outside the cabinet. This is a guaranteed net: if the ball
   * is ever outside the side/top boundary it is snapped back in and its
   * outward velocity is reflected. It can never fail because it is a pure
   * clamp, not a collision test. (The bottom is intentionally open: that is
   * the drain.) */
  if (ball.x < WALL.L + ball.r) {
    ball.x = WALL.L + ball.r;
    if (ball.vx < 0) ball.vx = -ball.vx * 0.4;
  } else if (ball.x > WALL.R - ball.r) {
    ball.x = WALL.R - ball.r;
    if (ball.vx > 0) ball.vx = -ball.vx * 0.4;
  }
  if (ball.y < WALL.T + ball.r) {
    ball.y = WALL.T + ball.r;
    if (ball.vy < 0) ball.vy = -ball.vy * 0.4;
  }

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
        addScore(b.value * _pb.mult * modeMult('bumper'));
        bumpCombo();
        onShotEvent('bumper', b.id || 'any', _table);
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
      // signature "live catch -> flick" punch. The swept flipper now emits a
      // FAN of sub-segments, so guard the punch to once per ball per frame to
      // avoid stacking it and over-launching.
      if (fl.up && Math.abs(fl.av) > 0.05 && ball.flipHitFrame !== _pb.tick) {
        ball.flipHitFrame = _pb.tick;
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
function addScore(n) {
  _pb.score += Math.round(n);
  // central extra-ball threshold check (covers every scoring path)
  if (_table && _table.extraBallScoreThresholds) checkExtraBallScoreThresholds(_table);
}
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
 * SECTION 15b — TABLE-AGNOSTIC GAME SYSTEMS
 * --------------------------------------------------------------------------
 * These systems are driven by *table data*, not table-specific code. Each
 * table declares its own shot sequence, mode definitions, story beats, and
 * extra-ball rules. The engine consumes those declarations the same way for
 * every table, so the second and third games can reuse all six systems by
 * writing data — no engine changes.
 *
 *   T.shotSequence    : [ { id, label, matchType, matchId } ]
 *   T.shotReward      : score per lit-shot hit (default 5000)
 *   T.shotCompleteBonus : score awarded for completing the full sequence
 *   T.modeDefs        : { modeName: { label, dur, mult, hookType, ... } }
 *   T.storyBeats      : { eventName: 'DMD TEXT' }
 *   T.extraBallScoreThresholds : [score values that award an extra ball]
 *
 *   Event hooks call:
 *     onShotEvent('ramp'|'wormhole'|'bumper'|'lock'|'target', id, T)
 *     onComboRamp(rampId, T)
 *     onScoreChanged(T)
 *     storyBeat(eventName, T)
 * ========================================================================== */

// ---- SHOT SEQUENCE ------------------------------------------------------
function currentShot(T) {
  if (!T.shotSequence || !T.shotSequence.length) return null;
  return T.shotSequence[_pb.shot.idx % T.shotSequence.length];
}
function onShotEvent(matchType, matchId, T) {
  const shot = currentShot(T);
  if (!shot) return false;
  if (shot.matchType !== matchType) return false;
  // matchId can be exact value, array of allowed values, or null = any of type
  if (shot.matchId !== null && shot.matchId !== undefined) {
    if (Array.isArray(shot.matchId)) {
      if (!shot.matchId.includes(matchId)) return false;
    } else if (shot.matchId !== matchId) return false;
  }
  // shot matched!
  const reward = (T.shotReward || 5000) * _pb.mult;
  addScore(reward);
  _pb.shot.hits++;
  _pb.shot.idx++;
  dmdFlash('SHOT LIT  +' + reward);
  snd('shotLit');
  // completed full sequence?
  if (_pb.shot.idx % T.shotSequence.length === 0) {
    _pb.shot.completedThisGame++;
    const bonus = (T.shotCompleteBonus || 25000) * _pb.mult;
    addScore(bonus);
    dmdFlash('SEQUENCE COMPLETE', '+' + bonus);
    snd('shotSequenceWin');
    // trigger configured reward-mode if any
    if (T.modeTriggers && T.modeTriggers.shotSequenceComplete) {
      startMode(T.modeTriggers.shotSequenceComplete, T);
    }
  }
  return true;
}

// ---- MODES --------------------------------------------------------------
function startMode(name, T) {
  const def = T.modeDefs && T.modeDefs[name];
  if (!def) return;
  if (_pb.mode.name) return; // already running, exclusive
  _pb.mode = {
    name, framesLeft: def.dur, mult: def.mult || 2,
    hookType: def.hookType, label: def.label || name.toUpperCase(),
  };
  if (def.storyStart) {
    dmdFlash(def.label || name.toUpperCase(), def.storyStart);
  } else {
    dmdFlash(def.label || name.toUpperCase(), 'MODE STARTED');
  }
  snd('modeStart');
}
function stepMode(T) {
  if (!_pb.mode.name) return;
  _pb.mode.framesLeft--;
  if (_pb.mode.framesLeft <= 0) {
    dmdFlash(_pb.mode.label, 'MODE ENDS');
    _pb.mode = { name: null, framesLeft: 0, mult: 1, hookType: null, label: '' };
    snd('modeEnd');
  }
}
// returns the score multiplier currently applicable to an event of a given type
function modeMult(hookType) {
  if (_pb.mode.name && _pb.mode.hookType === hookType) return _pb.mode.mult;
  return 1;
}

// ---- RAMP COMBO ---------------------------------------------------------
function onComboRamp(rampId, T) {
  const RC = _pb.rampCombo;
  if (RC.timer > 0 && RC.lastId && RC.lastId !== rampId) {
    RC.count++;
    const mult = RC.count + 1;
    const bonus = 2000 * mult * _pb.mult;
    addScore(bonus);
    dmdFlash('RAMP COMBO X' + mult, '+' + bonus);
    snd('combo');
    // big-combo reward-mode hook
    if (RC.count >= 3 && T.modeTriggers && T.modeTriggers.bigCombo) {
      startMode(T.modeTriggers.bigCombo, T);
    }
  } else {
    RC.count = 0;
  }
  RC.lastId = rampId;
  RC.timer = 180; // 3-second window to chain
}
function stepRampCombo() {
  if (_pb.rampCombo.timer > 0) {
    _pb.rampCombo.timer--;
    if (_pb.rampCombo.timer === 0) { _pb.rampCombo.count = 0; _pb.rampCombo.lastId = null; }
  }
}

// ---- EXTRA BALL ---------------------------------------------------------
function checkExtraBallScoreThresholds(T) {
  if (!T.extraBallScoreThresholds) return;
  for (const threshold of T.extraBallScoreThresholds) {
    const key = 'eb_threshold_' + threshold;
    if (_pb.score >= threshold && !_pb.storyShown[key]) {
      _pb.storyShown[key] = true;
      awardExtraBall(T, 'SCORE');
    }
  }
}
function awardExtraBall(T, reason) {
  _pb.extraBallsEarned++;
  _pb.ballsTotal++;
  dmdFlash('EXTRA BALL', reason || 'AWARDED');
  storyBeat('extraBall', T);
  snd('extraBall');
}

// ---- STORY BEATS --------------------------------------------------------
function storyBeat(eventName, T) {
  if (!T.storyBeats || !T.storyBeats[eventName]) return;
  if (_pb.storyShown[eventName]) return;
  _pb.storyShown[eventName] = true;
  dmdFlash(T.storyBeats[eventName]);
  snd('story');
}
// some beats are repeatable (e.g. mode trigger every time)
function storyBeatRepeatable(eventName, T) {
  if (!T.storyBeats || !T.storyBeats[eventName]) return;
  dmdFlash(T.storyBeats[eventName]);
  snd('story');
}

// ---- LIT TELEPORT-HOLE OBJECTIVES ---------------------------------------
// Light specific holes when conditions are met. A captured ball in a lit
// hole gets the bonus reward attached to that hole.
function updateLitHoles(T) {
  if (!T.teleHoles) return;
  // hole D ('secret') lights for SUPER on final ball if score >= threshold
  const last = (_pb.ball === _pb.ballsTotal);
  const dHole = T.teleHoles.find(h => h.label === 'D');
  if (dHole) {
    dHole.lit = last && _pb.score >= 30000 && !_pb.storyShown['superClaimed'];
    dHole.litReward = 'super';
  }
  // hole C lights during WORMHOLE RUSH mode
  const cHole = T.teleHoles.find(h => h.label === 'C');
  if (cHole) {
    cHole.lit = (_pb.mode.name === 'wormholeRush');
    cHole.litReward = 'rampBoost';
  }
}
function onLitHoleCapture(hole, T) {
  if (!hole.lit) return;
  if (hole.litReward === 'super') {
    _pb.storyShown['superClaimed'] = true;
    awardExtraBall(T, 'SUPER JACKPOT');
    addScore(50000 * _pb.mult);
  } else if (hole.litReward === 'rampBoost') {
    addScore(10000 * _pb.mult);
    dmdFlash('RAMP BOOST', '+10000');
  }
}

/* ==========================================================================
 * SECTION 16 — TABLE LOGIC DISPATCH
 * --------------------------------------------------------------------------
 * Generic event handler. The specific bank-completion behavior is provided
 * by each table as T.onBankComplete(group, T) — keeps the engine generic.
 * ========================================================================== */
function onTargetHit(t, T) {
  // count completion of a bank
  const bank = T.targets.filter(x => x.group === t.group);
  const done = bank.every(x => x.hit);
  if (done) {
    // table-specific bank-completion handler (optional)
    if (T.onBankComplete) T.onBankComplete(t.group, T);
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
  // story beats at progression milestones
  if (T.activeHoles === 2) storyBeat('twoWormholes', T);
  if (T.activeHoles >= 4 && !T.multiballArmed) {
    T.multiballArmed = true;
    storyBeat('fourWormholes', T);
    dmdFlash('WORMHOLES ALIGNED', 'LOCK BALL FOR MULTIBALL');
  }
}

function onWormHoleEnter(ball, wh, T) {
  // teleport ball to a random OTHER active hole
  const others = T.wormholes.filter(h => h.active && h !== wh);
  addScore(1500 * _pb.mult * modeMult('wormhole'));
  onShotEvent('wormhole', wh.idx, T);
  checkExtraBallScoreThresholds(T);
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
  dmdPlay(animTeleporter());
  bumpCombo();
}

function onBallLock(ball, T) {
  if (!T.lockZone.active) return;
  if (T.multiballArmed && _pb.balls.length === 1) {
    // START MULTIBALL
    T.lockZone.active = false;
    T.multiballArmed = false;
    dmdPlay(animMultiball());
    storyBeat('multiball', T);
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
    onShotEvent('lock', null, T);
    dmdPlay(animBallLock());
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
 * SECTION 16b — TIMED TELEPORT HOLES
 * --------------------------------------------------------------------------
 * Four mechanical holes are always visible on the playfield. They open and
 * close on a schedule that's partly random and partly tied to progression
 * (higher score / more wormholes active → more frequent cycling). When open,
 * a ball entering the hole is captured, held for ~1s, and ejected from a
 * random OTHER hole — including the "secret" pocket that is otherwise walled
 * off, giving the ball access to an area it can't reach by normal play.
 *
 * Progression stages (determined by score + wormhole count):
 *   stage 0 (start):      1 hole eligible at a time, cycles every 5-7s
 *   stage 1 (score > 15k): 2 holes eligible, cycles every 4-6s
 *   stage 2 (score > 50k): 3 holes eligible, cycles every 3-5s
 *   stage 3 (score > 100k):all 4 eligible, rapid 2-4s cycling
 * ========================================================================== */
function teleHoleStage() {
  const s = _pb.score;
  const wh = _table ? (_table.activeHoles || 0) : 0;
  if (s > 100000 || wh >= 4) return 3;
  if (s > 50000 || wh >= 3) return 2;
  if (s > 15000 || wh >= 2) return 1;
  return 0;
}
const TELE_STAGE_CFG = [
  { eligible: 1, minCycle: 300, maxCycle: 420 },   // 5-7s
  { eligible: 2, minCycle: 240, maxCycle: 360 },   // 4-6s
  { eligible: 3, minCycle: 180, maxCycle: 300 },   // 3-5s
  { eligible: 4, minCycle: 120, maxCycle: 240 },   // 2-4s
];

function resetTeleHoles(T) {
  if (!T.teleHoles) return;
  for (const h of T.teleHoles) {
    h.open = false; h.timer = 0; h.capturedBall = null;
    h.captureTimer = 0; h.iris = 0;
  }
  // seed the first open cycle
  const cfg = TELE_STAGE_CFG[0];
  T.teleHoles[0].timer = Math.floor(rand(60, 120));  // first hole opens quickly
}

function stepTeleHoles(T) {
  const stage = teleHoleStage();
  const cfg = TELE_STAGE_CFG[stage];
  // refresh lit-hole assignments each frame (cheap)
  updateLitHoles(T);

  for (const h of T.teleHoles) {
    // animate iris (visual smoothing)
    h.iris += (h.open ? 1 : -1) * 0.08;
    h.iris = clamp(h.iris, 0, 1);

    // handle captured ball
    if (h.capturedBall) {
      h.captureTimer--;
      if (h.captureTimer <= 0) {
        ejectFromTeleHole(h, T);
      }
      continue;
    }

    // cycle timer
    h.timer--;
    if (h.timer <= 0) {
      h.open = !h.open;
      if (h.open) {
        snd('holeOpen');
        h.timer = Math.floor(rand(90, 180)); // stay open 1.5-3s
      } else {
        // pick next open time
        h.timer = Math.floor(rand(cfg.minCycle, cfg.maxCycle));
      }
    }

    // capture check — only for open holes with no captured ball
    if (h.open) {
      for (const ball of _pb.balls) {
        if (ball.dead || ball.inLane || ball.laneFeed || ball.onRamp) continue;
        if (dist(ball.x, ball.y, h.x, h.y) < h.r + ball.r * 0.5) {
          captureBallInTeleHole(ball, h, T);
          break;
        }
      }
    }
  }

  // ensure the right number of holes are cycling at this stage
  const openOrCycling = T.teleHoles.filter(h => h.open || h.timer > 0).length;
  if (openOrCycling < cfg.eligible) {
    // pick a random idle hole and start its timer
    const idle = T.teleHoles.filter(h => !h.open && h.timer <= 0 && !h.capturedBall);
    if (idle.length) {
      const pick = idle[Math.floor(rand(0, idle.length))];
      pick.timer = Math.floor(rand(30, cfg.minCycle));
    }
  }
}

function captureBallInTeleHole(ball, hole, T) {
  // hide the ball inside the hole and start hold timer
  hole.capturedBall = ball;
  hole.captureTimer = hole.holdFrames;
  ball.x = hole.x; ball.y = hole.y;
  ball.vx = 0; ball.vy = 0;
  // mark ball so physics skips it while captured
  ball._captured = true;
  addScore(500 * _pb.mult);
  onLitHoleCapture(hole, T);
  dmdPlay(animTeleporter());
}

function ejectFromTeleHole(srcHole, T) {
  const ball = srcHole.capturedBall;
  if (!ball) return;
  srcHole.capturedBall = null;
  ball._captured = false;

  // pick a random OTHER hole to eject from (prefer open ones, include secret)
  const others = T.teleHoles.filter(h => h !== srcHole && !h.capturedBall);
  let dest;
  if (others.length) {
    dest = others[Math.floor(rand(0, others.length))];
  } else {
    dest = srcHole; // fallback: eject from same hole
  }

  ball.x = dest.x;
  ball.y = dest.y + dest.r + 4;
  const a = rand(Math.PI * 0.15, Math.PI * 0.85);
  const s = rand(6, 10);
  ball.vx = Math.cos(a) * s;
  ball.vy = Math.abs(Math.sin(a) * s);
  ball.onRamp = null;
  snd('warp');
}


/* ==========================================================================
 * SECTION 17 — GAME LOOP
 * ========================================================================== */
function startGame(usingCredit = false) {
  const keepCredits = _pb.credits || loadCredits();
  _pb = freshPB();
  _pb.highScore = loadHighScore(_table.id);
  _pb.credits = usingCredit ? Math.max(0, keepCredits - 1) : keepCredits;
  if (usingCredit) saveCredits(_pb.credits);
  _pb.phase = 'plunge';
  _pb.started = true;
  // reset table logic
  resetTableLogic(_table);
  // game-start cutscene on the DMD, then hand control back to play readout
  dmdPlayExclusive(animGameStart(_table));
  // queue the gameStart story beat after the cutscene so the player sees it
  setTimeout(() => { if (_running) storyBeat('gameStart', _table); }, 2600);
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
  if (T.teleHoles) resetTeleHoles(T);
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
    endGame();
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

/* End-of-game flow (sequenced through the DMD animation queue):
 *   game-over cutscene
 *   -> if score makes the table: initials entry (flipper-driven)
 *   -> high-score celebration + free game
 *   -> MATCH sequence (random 1-in-10) -> free game on match
 *   -> return to attract reel
 * The sequencing is driven in tick() by watching the queue drain and the
 * _pb.endStage marker. */
function endGame() {
  _pb.phase = 'gameover';
  const id = _table.id;
  const isHigh = _pb.score > _pb.highScore;
  if (_pb.score > _pb.highScore) _pb.highScore = _pb.score;
  if (isHigh) storyBeat('victory', _table);
  _pb.endStage = 'gameover';
  _pb.endQualifies = qualifiesForTable(id, _pb.score);
  dmdPlayExclusive(animGameOver(_table, _pb.score, isHigh));
}
// called from tick() when the game-over / post-game animations finish
function advanceEndStage() {
  const id = _table.id;
  if (_pb.endStage === 'gameover') {
    if (_pb.endQualifies) {
      // enter initials
      _pb.endStage = 'initials';
      _pb.initials = { active: true, slot: 0, idx: 0, letters: ['A', 'A', 'A'] };
      dmdPlayExclusive(animInitialsEntry());
    } else {
      _pb.endStage = 'match';
      runMatchSequence();
    }
  } else if (_pb.endStage === 'initials') {
    // initials confirmed elsewhere; commit + celebrate
    const name = _pb.initials.letters.join('').replace(/ /g, 'A');
    commitHighScore(id, name, _pb.score);
    awardCredit('HIGH SCORE');
    _pb.endStage = 'highscore';
    dmdPlayExclusive(animHighScore(_pb.score));
  } else if (_pb.endStage === 'highscore') {
    _pb.endStage = 'match';
    runMatchSequence();
  } else if (_pb.endStage === 'match') {
    if (_pb.matchWon) awardCredit('MATCH');
    _pb.endStage = 'freegame';
    if (_pb.pendingFreeGame) {
      dmdPlayExclusive(animFreeGame(_pb.pendingFreeGame));
      _pb.pendingFreeGame = null;
    } else {
      _pb.endStage = 'done';
    }
  } else if (_pb.endStage === 'freegame') {
    _pb.endStage = 'done';
  }
  if (_pb.endStage === 'done') {
    // back to attract
    _pb.phase = 'attract';
    _pb.endStage = null;
    dmdPlayExclusive(animAttractReel(_table));
  }
}
// the classic "match" — last digit of score vs a random digit, 1-in-10
function runMatchSequence() {
  const playerDigit = Math.floor(_pb.score / 10) % 10;
  const matchDigit = Math.floor(Math.random() * 10);
  _pb.matchWon = (playerDigit === matchDigit);
  dmdPlayExclusive(animMatch(playerDigit, matchDigit, _pb.matchWon));
}
function awardCredit(reason) {
  _pb.credits = (_pb.credits || 0) + 1;
  saveCredits(_pb.credits);
  _pb.pendingFreeGame = reason;       // shown after the match sequence
  snd('pop');
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
    // timed teleport holes open/close + capture
    if (_table.teleHoles) stepTeleHoles(_table);
    stepMode(_table);
    stepRampCombo();

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

  // ---- end-of-game sequencing -----------------------------------------
  // when a post-game cutscene finishes (queue drains), advance the flow.
  if (_pb.phase === 'gameover' && _pb.endStage && _pb.endStage !== 'initials'
      && _pb.endStage !== 'done' && !dmdBusy()) {
    advanceEndStage();
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

  // ---- upper-deck decor (drawn FIRST so ramps render over them as glass) ----
  if (T.upperDeck && T.upperDeck.length) {
    for (const u of T.upperDeck) drawUpperDeckItem(ctx, u, T);
  }
  // ---- shower spray (Shower Defense) — drawn under ramps so ball is visible ----
  if (T.shower) drawShowerSpray(ctx, T);

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
    ctx.fillText(T.lockZone.label || 'LOCK', T.lockZone.x, T.lockZone.y + 3);
  }

  // ---- rollover lanes ----
  for (const ln of T.lanes) {
    ctx.beginPath();
    ctx.arc(ln.x, ln.y, 9, 0, TAU);
    ctx.fillStyle = ln.lit ? T.colors.neon2 : 'rgba(255,255,255,0.15)';
    ctx.fill();
  }

  // ---- teleport holes (mechanical iris) ----
  if (T.teleHoles) {
    for (const h of T.teleHoles) {
      drawTeleHole(ctx, h, T);
    }
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

/* ==========================================================================
 * UPPER-DECK and TABLE-SPECIFIC DECOR
 * --------------------------------------------------------------------------
 * Draws decorative items in the upper part of the playfield BEFORE ramps,
 * so that translucent ramps render over them — the ball travelling on the
 * ramp looks like it's gliding over the booths/sink/etc. Below-ramp items
 * remain readable.
 * ========================================================================== */
function drawUpperDeckItem(ctx, u, T) {
  ctx.save();
  if (u.kind === 'booth') {
    // booth = a small table-circle with a number
    ctx.beginPath();
    ctx.arc(u.x, u.y, u.r, 0, TAU);
    ctx.fillStyle = u.served ? 'rgba(109,212,74,0.45)' : 'rgba(255,179,48,0.20)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = u.served ? T.colors.neon2 : T.colors.neon;
    ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(u.label, u.x, u.y + 4);
  } else if (u.kind === 'sign') {
    // neon diner sign — blinking
    const blink = ((_pb.tick >> 4) & 1) ? 1 : 0.6;
    ctx.shadowColor = T.colors.neon; ctx.shadowBlur = 14 * blink;
    ctx.strokeStyle = T.colors.neon; ctx.lineWidth = 2;
    ctx.strokeRect(u.x - u.w/2, u.y - u.h/2, u.w, u.h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = T.colors.neon;
    ctx.font = 'bold 18px "Courier New", monospace'; ctx.textAlign = 'center';
    ctx.globalAlpha = blink;
    ctx.fillText(u.text || '', u.x, u.y + 6);
    ctx.globalAlpha = 1;
  } else if (u.kind === 'plant') {
    // little potted plant
    ctx.fillStyle = '#5a3a20';
    ctx.fillRect(u.x - u.r * 0.7, u.y, u.r * 1.4, u.r * 0.8);
    ctx.fillStyle = T.colors.neon2 || '#6dd44a';
    ctx.beginPath();
    for (let a = 0; a < TAU; a += 0.6) {
      ctx.moveTo(u.x, u.y);
      ctx.lineTo(u.x + Math.cos(a) * u.r, u.y - Math.abs(Math.sin(a)) * u.r);
    }
    ctx.strokeStyle = T.colors.neon2 || '#6dd44a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function drawShowerSpray(ctx, T) {
  const sh = T.shower;
  if (!sh) return;
  ctx.save();
  // showerhead
  ctx.fillStyle = '#9eb5c0';
  ctx.fillRect(sh.headX - 22, sh.headY - 6, 44, 10);
  ctx.fillRect(sh.headX - 2, sh.headY - 14, 4, 10); // pipe up
  // spray when ON: animated water beams
  if (sh.on) {
    sh.spray = (sh.spray + 0.25) % 1;
    ctx.strokeStyle = hexA(T.colors.neon, 0.55);
    ctx.lineWidth = 2;
    for (let i = -3; i <= 3; i++) {
      const x = sh.headX + i * 7;
      const startY = sh.headY + 4;
      const len = 110 + Math.sin(_pb.tick * 0.15 + i) * 8;
      const drop = ((sh.spray + i * 0.1) % 1) * 30;
      ctx.beginPath();
      ctx.moveTo(x, startY + drop);
      ctx.lineTo(x - 6, startY + drop + len * 0.6);
      ctx.stroke();
    }
    // tub puddle glow
    ctx.fillStyle = hexA(T.colors.neon, 0.18);
    ctx.beginPath();
    ctx.ellipse(sh.headX, sh.curtainY, 60, 12, 0, 0, TAU);
    ctx.fill();
  }
  // wave-status decor: a row of mini icons showing remaining waves
  ctx.fillStyle = T.colors.decor || '#a8e8e8';
  ctx.font = '10px monospace'; ctx.textAlign = 'left';
  ctx.fillText('WAVE ' + (T.wave || 1), 460, 30);
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

function drawTeleHole(ctx, h, T) {
  ctx.save();
  // outer ring — always visible (the "mechanical housing")
  ctx.beginPath();
  ctx.arc(h.x, h.y, h.r + 3, 0, TAU);
  ctx.fillStyle = '#181828';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#7f6faf';
  ctx.stroke();

  // iris animation — blades that open/close
  const open = clamp(h.iris, 0, 1);
  if (open > 0.02) {
    // open hole glow
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r * open * 0.8, 0, TAU);
    ctx.fillStyle = 'rgba(57,215,255,0.3)';
    ctx.shadowColor = '#39d7ff'; ctx.shadowBlur = 12 * open;
    ctx.fill();
    ctx.shadowBlur = 0;
    // iris blades (draw 6 wedge-shaped blades that retract when opening)
    const blades = 6;
    const closed = 1 - open;
    for (let i = 0; i < blades; i++) {
      const a = i * (TAU / blades) + _pb.tick * 0.02;
      const inner = h.r * (1 - closed * 0.85);
      const outer = h.r;
      const hw = (TAU / blades) * 0.35 * closed; // blade half-width shrinks as it opens
      ctx.beginPath();
      ctx.moveTo(h.x + Math.cos(a - hw) * inner, h.y + Math.sin(a - hw) * inner);
      ctx.lineTo(h.x + Math.cos(a - hw) * outer, h.y + Math.sin(a - hw) * outer);
      ctx.lineTo(h.x + Math.cos(a + hw) * outer, h.y + Math.sin(a + hw) * outer);
      ctx.lineTo(h.x + Math.cos(a + hw) * inner, h.y + Math.sin(a + hw) * inner);
      ctx.closePath();
      ctx.fillStyle = '#3a3552';
      ctx.fill();
    }
  } else {
    // fully closed — solid disc
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, TAU);
    ctx.fillStyle = '#2a2540';
    ctx.fill();
  }

  // label
  ctx.fillStyle = h.open ? '#39d7ff' : '#7f6faf';
  ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
  ctx.fillText(h.label, h.x, h.y + 3);

  // LIT indicator: pulsing ring when this hole offers a special reward
  if (h.lit) {
    const pulse = 1 + 0.4 * Math.sin(_pb.tick * 0.18);
    ctx.beginPath();
    ctx.arc(h.x, h.y, (h.r + 6) * pulse, 0, TAU);
    ctx.strokeStyle = h.litReward === 'super' ? '#ffd700' : '#ff3ea5';
    ctx.lineWidth = 2;
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // captured ball indicator: a small pulsing dot
  if (h.capturedBall) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 4 + Math.sin(_pb.tick * 0.3) * 2, 0, TAU);
    ctx.fillStyle = '#ff3ea5';
    ctx.shadowColor = '#ff3ea5'; ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
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
  let grid = null;
  const T = _table;

  // priority: animation queue (cutscenes / attract / initials) wins, then
  // the legacy flash message, then the plain phase-based readout.
  if (dmdBusy()) {
    grid = dmdStepAnim();
  }
  if (!grid) {
    grid = newGrid();
    if (_pb.dmd.timer > 0) {
      // FLASH message takes over
      dmdTextCentered(grid, _pb.dmd.msg.substring(0, 16), 5, 1);
      if (_pb.dmd.sub) dmdTextCentered(grid, _pb.dmd.sub.substring(0, 16), 15, 1);
    } else if (_pb.phase === 'attract') {
      // attract should normally be the looping reel; this is a fallback
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
      // PLAY: score top-right, ball top-left, shot label middle,
      // mode timer or combo bottom, multiball + credits aux row
      const scoreStr = shortNum(_pb.score);
      dmdText(grid, scoreStr, Math.max(2, DMD.cols - scoreStr.length * 6 - 2), 1, 1);
      dmdText(grid, 'BALL ' + _pb.ball + '/' + _pb.ballsTotal, 2, 1, 1);

      // CURRENT SHOT (centered, prominent)
      const shot = currentShot(_table);
      if (shot && !_pb.mode.name) {
        dmdTextCentered(grid, shot.label.substring(0, 16), 10, ((_pb.dmd.t>>3)&1) ? 1 : 1);
      }
      // MODE BANNER (replaces shot label while active)
      if (_pb.mode.name) {
        dmdTextCentered(grid, _pb.mode.label.substring(0, 16), 10, 1);
        const secs = Math.ceil(_pb.mode.framesLeft / 60);
        dmdTextCentered(grid, secs + 'S  X' + _pb.mode.mult, 17, ((_pb.dmd.t>>2)&1));
      } else if (_pb.rampCombo.count > 0) {
        dmdTextCentered(grid, 'COMBO X' + (_pb.rampCombo.count + 1), 17, ((_pb.dmd.t>>2)&1));
      } else {
        // status row: mult / combo / balls / credits
        dmdText(grid, 'X' + _pb.mult, 2, 17, 1);
        if (_pb.combo > 1) dmdText(grid, 'CMB ' + _pb.combo, 20, 17, 1);
        if (_pb.balls.length > 1) dmdText(grid, _pb.balls.length + ' BALLS', 50, 17, ((_pb.dmd.t>>3)&1));
        if (_pb.credits > 0) dmdText(grid, 'CR ' + _pb.credits, DMD.cols - 30, 17, 1);
      }
      // EB indicator if a lit hole is offering an extra ball
      const ebLit = _table.teleHoles && _table.teleHoles.some(h => h.lit && h.litReward === 'super');
      if (ebLit) dmdTextCentered(grid, 'HOLE D LIT - SUPER', 22, ((_pb.dmd.t>>3)&1));
    }
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
 * --------------------------------------------------------------------------
 * Two layers: a single best score (legacy key, kept for the simple HUD) and
 * a full top-5 table with 3-letter initials (used by the attract reel and
 * the end-of-game initials entry).
 * ========================================================================== */
function loadHighScore(id) {
  try { return parseInt(localStorage.getItem('pinball_hi_' + id) || '0', 10) || 0; }
  catch (e) { return 0; }
}
function saveHighScore(id, score) {
  try { localStorage.setItem('pinball_hi_' + id, String(score)); } catch (e) {}
}
// default table shown before anyone has played
function defaultHighTable() {
  return [
    { name: 'CRX', score: 120000 },
    { name: 'NVA', score: 90000 },
    { name: 'QBT', score: 60000 },
    { name: 'ION', score: 35000 },
    { name: 'AAA', score: 15000 },
  ];
}
function loadHighTable(id) {
  try {
    const raw = localStorage.getItem('pinball_hitable_' + id);
    if (!raw) return defaultHighTable();
    const t = JSON.parse(raw);
    if (Array.isArray(t) && t.length) return t;
    return defaultHighTable();
  } catch (e) { return defaultHighTable(); }
}
function saveHighTable(id, table) {
  try { localStorage.setItem('pinball_hitable_' + id, JSON.stringify(table)); } catch (e) {}
}
// is this score good enough to make the top 5?
function qualifiesForTable(id, score) {
  const t = loadHighTable(id);
  return score > 0 && (t.length < 5 || score > t[t.length - 1].score);
}
// insert a new {name,score} and keep the top 5
function commitHighScore(id, name, score) {
  const t = loadHighTable(id);
  t.push({ name: (name || 'AAA').substring(0, 3), score });
  t.sort((a, b) => b.score - a.score);
  while (t.length > 5) t.pop();
  saveHighTable(id, t);
  if (score > loadHighScore(id)) saveHighScore(id, score);
  return t;
}
// credit (free game) counter
function loadCredits() {
  try { return parseInt(localStorage.getItem('pinball_credits') || '0', 10) || 0; }
  catch (e) { return 0; }
}
function saveCredits(n) {
  try { localStorage.setItem('pinball_credits', String(Math.max(0, n))); } catch (e) {}
}

/* ==========================================================================
 * SECTION 21 — TABLE FACTORY
 * --------------------------------------------------------------------------
 * buildTable() returns a fully-built table or a 'placeholder' marker for the
 * not-yet-built games. Adding a real table later = add a builder + case.
 * ========================================================================== */
function buildTable(id, tdef) {
  switch (id) {
    case 'worm_holer':     return buildWormHoler(tdef);
    case 'cosmic_cluckers':return buildCosmicCluckers(tdef);
    case 'shower_defense': return buildShowerDefense(tdef);
    // legacy id kept so old links still work
    case 'barfs_house':    return buildCosmicCluckers(tdef);
    default:               return buildWormHoler(tdef);
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

  bindHold(lBtn, () => onFlipperPress('L'), () => onFlipperRelease('L'));
  bindHold(rBtn, () => onFlipperPress('R'), () => onFlipperRelease('R'));
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
  const avail = window.innerHeight - 270; // room for taller dmd + controls
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

/* During INITIALS entry the flipper buttons become a letter selector:
 *   left flipper  = previous letter
 *   right flipper = next letter
 *   launch        = confirm slot (3rd confirm finishes entry)
 * We edge-detect here so a press is one step, not a repeat. */
function initialsInput(which) {
  const st = _pb.initials;
  if (!st || !st.active) return;
  if (which === 'left' || which === 'right') {
    st.idx = (st.idx + (which === 'right' ? 1 : -1) + INITIALS_ALPHABET.length)
             % INITIALS_ALPHABET.length;
    const ch = INITIALS_ALPHABET[st.idx];
    st.letters[st.slot] = (ch === '<') ? ' ' : ch;
    snd('cursor');
  } else if (which === 'confirm') {
    const ch = INITIALS_ALPHABET[st.idx];
    if (ch === '<' && st.slot > 0) {
      // back up a slot
      st.slot--;
      st.idx = INITIALS_ALPHABET.indexOf(st.letters[st.slot] || 'A');
      if (st.idx < 0) st.idx = 0;
      snd('cursor');
      return;
    }
    if (ch === '<') { st.letters[st.slot] = 'A'; }
    snd('confirm');
    st.slot++;
    if (st.slot >= 3) {
      // done
      st.active = false;
      dmdClearQueue();
      advanceEndStage();         // -> commit + celebrate
    } else {
      st.idx = INITIALS_ALPHABET.indexOf(st.letters[st.slot] || 'A');
      if (st.idx < 0) st.idx = 0;
    }
  }
}

function onLaunchPress() {
  resumeAudio();
  // initials entry: launch confirms the current letter
  if (_pb.initials && _pb.initials.active) { initialsInput('confirm'); return; }
  if (_pb.phase === 'attract') {
    // start a game; consume a credit if any are banked
    const credit = (_pb.credits || 0) > 0;
    startGame(credit);
    return;
  }
  if (_pb.phase === 'gameover') {
    // ignore launch until the post-game sequence has returned to attract
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
// flipper press entry point — routes to initials selector when entering name
function onFlipperPress(side) {
  if (_pb.initials && _pb.initials.active) {
    initialsInput(side === 'L' ? 'left' : 'right');
    return;
  }
  _keys[side === 'L' ? 'left' : 'right'] = true;
}
function onFlipperRelease(side) {
  _keys[side === 'L' ? 'left' : 'right'] = false;
}

function onKeyDown(e) {
  if (e.repeat) return;
  resumeAudio();
  switch (e.key) {
    case 'ArrowLeft':  onFlipperPress('L'); e.preventDefault(); break;
    case 'ArrowRight': onFlipperPress('R'); e.preventDefault(); break;
    case ' ': case 'Spacebar':
      e.preventDefault();
      onLaunchPress();
      break;
    case 'Escape': closePinball(); break;
  }
}
function onKeyUp(e) {
  switch (e.key) {
    case 'ArrowLeft':  onFlipperRelease('L'); break;
    case 'ArrowRight': onFlipperRelease('R'); break;
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
  _pb.credits = loadCredits();
  // kick off the looping attract reel on the DMD
  dmdPlayExclusive(animAttractReel(_table));
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
