/**
 * Pinball Buddy — Pinball Engine for Spaced & Standalone
 * =======================================================
 * Entry point (Spaced): openPinball(tableId, state, data, api)
 * Standalone:           openPinball('worm_holer')
 *
 * Tables: worm_holer | barfs_house | shower_defense
 * Physics: canvas-based, Z-layer ramps, multi-flipper, Web Audio
 * Controls: left/right arrow keys, on-screen buttons (touch + mouse)
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const PB = {
  W: 480,          // playfield width
  H: 820,          // playfield height (portrait)
  DMD_H: 120,      // dot-matrix display height
  BALL_R: 11,
  GRAVITY: 0.32,
  FRICTION: 0.9985,
  WALL_BOUNCE: 0.62,
  BUMPER_FORCE: 9.5,
  FLIPPER_FORCE: 18,
  PLUNGER_MAX: 24,
  MIN_SPEED: 0.08,
  DRAIN_Y: 840,
  FPS: 60,
};

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let _overlay     = null;
let _canvas      = null;
let _dmd         = null;       // DMD canvas
let _ctx         = null;
let _dctx        = null;
let _animId      = null;
let _audioCtx    = null;
let _state       = null;       // Spaced state (null if standalone)
let _data        = null;
let _api         = null;
let _table       = null;       // active table definition
let _tableDef    = null;       // raw JSON table config

// Keys held
const _keys = { left: false, right: false, space: false };

// ─── PINBALL GAME STATE ───────────────────────────────────────────────────────

let _pb = {};

function freshPBState(tableId) {
  return {
    tableId,
    ball: { x: PB.W - 30, y: PB.H - 120, vx: 0, vy: 0, z: 0, vz: 0, active: false, lost: false },
    extraBalls: [],            // multiball
    flippers: [],              // populated by table
    bumpers: [],
    targets: [],
    ramps: [],
    lights: [],
    wormHoles: [],
    score: 0,
    ballsLeft: 3,
    ballNum: 1,
    multiplier: 1,
    combo: 0,
    comboTimer: 0,
    plungerCharge: 0,
    plunging: false,
    launched: false,
    tilt: false,
    tiltWarnings: 0,
    phase: 'attract',          // attract | plunge | play | lost | gameover | scores
    phaseTimer: 0,
    modeActive: null,
    modeTimer: 0,
    modeData: {},
    dmdAnim: 'attract',
    dmdFrame: 0,
    dmdTimer: 0,
    dmdText: '',
    tableProgress: {},         // table-specific flags/counters
    highScores: [],
    lastMatch: null,
    lastPulse: [],             // bumper/target hit flash indicators
  };
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export function openPinball(tableId, state, data, api) {
  _state = state || null;
  _data  = data  || null;
  _api   = api   || null;

  // Load table config
  const tables = (_data?.pinball?.tables) || loadStandaloneTables();
  _tableDef = tables.find(t => t.id === tableId) || tables[0];

  injectStyles();
  if (_overlay) { _overlay.remove(); cancelAnimationFrame(_animId); cleanup(); }

  _overlay = document.createElement('div');
  _overlay.id = 'pinballOverlay';
  _overlay.className = 'pb-overlay';
  document.body.appendChild(_overlay);

  buildUI();
  _pb = freshPBState(tableId);
  _table = buildTable(tableId);
  _pb.flippers = _table.flippers;
  _pb.bumpers  = _table.bumpers;
  _pb.targets  = _table.targets;
  _pb.ramps    = _table.ramps;
  _pb.lights   = _table.lights;
  _pb.wormHoles= _table.wormHoles || [];

  // Load high scores from localStorage
  const saved = JSON.parse(localStorage.getItem('pb_scores_' + tableId) || '[]');
  _pb.highScores = saved;

  initAudio();
  bindControls();
  _pb.phase = 'attract';
  startLoop();
}

function loadStandaloneTables() {
  // Fallback for standalone — return minimal table list
  return [
    { id:'worm_holer',    name:'WORM HOLER',    subtitle:'Survive the Singularity', theme:'space',    ballColor:'#c0e0ff', accentColor:'#4400ff', secondColor:'#ff00cc', bgColor:'#000008', highScores:[] },
    { id:'barfs_house',   name:"BARF'S HOUSE",  subtitle:'Based on the Hit TV Show!',theme:'sitcom',   ballColor:'#ffdd00', accentColor:'#ff6600', secondColor:'#00cc44', bgColor:'#1a0800', highScores:[] },
    { id:'shower_defense',name:'SHOWER DEFENSE',subtitle:'Defend Your Drain!',       theme:'bathroom', ballColor:'#aaddff', accentColor:'#0088ff', secondColor:'#00ffcc', bgColor:'#001820', highScores:[] },
  ];
}

// ─── UI BUILD ─────────────────────────────────────────────────────────────────

function buildUI() {
  const ac = _tableDef?.accentColor || '#4400ff';
  _overlay.innerHTML = `
    <div class="pb-shell" id="pbShell">
      <!-- DMD display -->
      <div class="pb-dmd-wrap">
        <canvas id="pbDMD" width="480" height="${PB.DMD_H}"></canvas>
      </div>

      <!-- Main playfield canvas -->
      <div class="pb-field-wrap">
        <canvas id="pbCanvas" width="${PB.W}" height="${PB.H}"></canvas>

        <!-- Touch/click flipper buttons -->
        <div class="pb-controls" id="pbControls">
          <button class="pb-btn pb-btn-left" id="pbBtnLeft"
            onmousedown="pbBtnDown('left')" onmouseup="pbBtnUp('left')"
            ontouchstart="pbBtnDown('left')" ontouchend="pbBtnUp('left')">
            ◀ LEFT
          </button>
          <button class="pb-btn pb-btn-launch" id="pbBtnLaunch"
            onmousedown="pbBtnDown('space')" onmouseup="pbBtnUp('space')"
            ontouchstart="pbBtnDown('space')" ontouchend="pbBtnUp('space')">
            LAUNCH
          </button>
          <button class="pb-btn pb-btn-right" id="pbBtnRight"
            onmousedown="pbBtnDown('right')" onmouseup="pbBtnUp('right')"
            ontouchstart="pbBtnDown('right')" ontouchend="pbBtnUp('right')">
            RIGHT ▶
          </button>
        </div>
      </div>

      <!-- Close button -->
      <button class="pb-close" onclick="pbClose()">✕</button>
    </div>`;

  _canvas = document.getElementById('pbCanvas');
  _ctx    = _canvas.getContext('2d');
  _dmd    = document.getElementById('pbDMD');
  _dctx   = _dmd.getContext('2d');

  // Global helpers for onclick attrs
  window.pbBtnDown = (k) => { _keys[k] = true; };
  window.pbBtnUp   = (k) => { _keys[k] = false; };
  window.pbClose   = () => pbClose();
}

function bindControls() {
  const kd = e => {
    if (e.key === 'ArrowLeft')  { _keys.left  = true; e.preventDefault(); }
    if (e.key === 'ArrowRight') { _keys.right = true; e.preventDefault(); }
    if (e.key === ' ')          { _keys.space = true; e.preventDefault(); }
    if (e.key === 'Escape')     { pbClose(); }
  };
  const ku = e => {
    if (e.key === 'ArrowLeft')  _keys.left  = false;
    if (e.key === 'ArrowRight') _keys.right = false;
    if (e.key === ' ')          _keys.space = false;
  };
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup',   ku);
  _overlay._kd = kd; _overlay._ku = ku;
}

function cleanup() {
  if (_overlay?._kd) window.removeEventListener('keydown', _overlay._kd);
  if (_overlay?._ku) window.removeEventListener('keyup',   _overlay._ku);
  if (_audioCtx) { try { _audioCtx.close(); } catch(e){} _audioCtx = null; }
}

function pbClose() {
  cancelAnimationFrame(_animId);
  cleanup();
  _overlay?.remove();
  _overlay = null;
}

// ─── TABLE DEFINITIONS ────────────────────────────────────────────────────────

function buildTable(tableId) {
  switch(tableId) {
    case 'worm_holer':    return buildWormHoler();
    case 'barfs_house':   return buildBarfsHouse();
    case 'shower_defense':return buildShowerDefense();
    default:              return buildWormHoler();
  }
}

// ─── WORM HOLER TABLE ─────────────────────────────────────────────────────────

function buildWormHoler() {
  return {
    id: 'worm_holer',
    flippers: [
      // Bottom pair
      { x:120, y:750, angle:-0.52, len:64, w:10, side:'left',  active:false, z:0 },
      { x:360, y:750, angle:Math.PI+0.52, len:64, w:10, side:'right', active:false, z:0 },
      // Mid-table pair (smaller)
      { x:95,  y:520, angle:-0.45, len:48, w:8, side:'left',  active:false, z:0, midTable:true },
      { x:385, y:520, angle:Math.PI+0.45, len:48, w:8, side:'right', active:false, z:0, midTable:true },
    ],
    bumpers: [
      // Event horizon bumpers (circular, labeled by star system)
      { x:180, y:200, r:24, label:'SOL',     pts:100, color:'#2244ff', ring:'#4488ff', hits:0 },
      { x:300, y:180, r:24, label:'VEGA',    pts:150, color:'#8822ff', ring:'#cc44ff', hits:0 },
      { x:240, y:260, r:20, label:'CORE',    pts:200, color:'#ff2244', ring:'#ff6688', hits:0 },
      { x:140, y:310, r:18, label:'NOVA',    pts:120, color:'#2266ff', ring:'#44aaff', hits:0 },
      { x:340, y:300, r:18, label:'CYGNUS',  pts:120, color:'#9922ff', ring:'#cc66ff', hits:0 },
      // Upper zone - deep space
      { x:200, y:130, r:16, label:'DEEP',    pts:300, color:'#ff4400', ring:'#ff8844', hits:0, upper:true },
      { x:280, y:120, r:16, label:'VOID',    pts:300, color:'#4400ff', ring:'#8844ff', hits:0, upper:true },
    ],
    targets: [
      // Event horizon targets - hit all 4 to activate worm hole
      { x:60,  y:420, w:14, h:36, label:'W', pts:500,  color:'#4488ff', hit:false, group:'wormgate' },
      { x:60,  y:460, w:14, h:36, label:'O', pts:500,  color:'#4488ff', hit:false, group:'wormgate' },
      { x:60,  y:500, w:14, h:36, label:'R', pts:500,  color:'#4488ff', hit:false, group:'wormgate' },
      { x:60,  y:540, w:14, h:36, label:'M', pts:500,  color:'#4488ff', hit:false, group:'wormgate' },
      // Right side: HOLE
      { x:406, y:420, w:14, h:36, label:'H', pts:500,  color:'#ff44cc', hit:false, group:'wormgate2' },
      { x:406, y:460, w:14, h:36, label:'O', pts:500,  color:'#ff44cc', hit:false, group:'wormgate2' },
      { x:406, y:500, w:14, h:36, label:'L', pts:500,  color:'#ff44cc', hit:false, group:'wormgate2' },
      { x:406, y:540, w:14, h:36, label:'E', pts:500,  color:'#ff44cc', hit:false, group:'wormgate2' },
      // Bonus multiplier drop targets
      { x:180, y:440, w:12, h:28, label:'2×', pts:1000, color:'#ffaa00', hit:false, group:'multi' },
      { x:200, y:440, w:12, h:28, label:'3×', pts:1000, color:'#ffaa00', hit:false, group:'multi' },
      { x:220, y:440, w:12, h:28, label:'5×', pts:1000, color:'#ffaa00', hit:false, group:'multi' },
    ],
    ramps: [
      // Left orbit ramp — goes to upper playfield
      { type:'orbit', side:'left',
        path:[ {x:80,y:650},{x:50,y:500},{x:50,y:300},{x:120,y:160},{x:200,y:140} ],
        exitX:200, exitY:140, exitVx:2, exitVy:-1, z:1, color:'#224488' },
      // Right orbit ramp
      { type:'orbit', side:'right',
        path:[ {x:400,y:650},{x:430,y:500},{x:430,y:300},{x:360,y:160},{x:280,y:140} ],
        exitX:280, exitY:140, exitVx:-2, exitVy:-1, z:1, color:'#442288' },
      // Center loop ramp — short, goes up and loops back
      { type:'loop',
        path:[ {x:200,y:400},{x:200,y:300},{x:280,y:300},{x:280,y:400} ],
        exitX:280, exitY:400, exitVx:1, exitVy:2, z:1, color:'#883300' },
    ],
    wormHoles: [
      { x:240, y:720, r:22, active:false, linkedTo:1, color:'#4400ff', label:'ENTRANCE',hits:0 },
      { x:120, y:250, r:18, active:false, linkedTo:2, color:'#8800ff', label:'EXIT A',  hits:0 },
      { x:360, y:250, r:18, active:false, linkedTo:3, color:'#cc00ff', label:'EXIT B',  hits:0 },
      { x:240, y:160, r:18, active:false, linkedTo:0, color:'#ff00cc', label:'DEEP',    hits:0 },
    ],
    lights: buildWHLights(),
    tableLogic: wormHolerLogic,
    drawExtra: drawWormHoler,
    wallColor: '#0a0a2a',
    railColor: '#002288',
    fieldColor: '#00000c',
    inlaneColor: '#0011aa',
  };
}

function buildWHLights() {
  const lights = [];
  // Star field lights scattered on playfield
  for (let i = 0; i < 30; i++) {
    lights.push({
      x: 60 + Math.random() * 360,
      y: 100 + Math.random() * 650,
      r: 1.5 + Math.random() * 2,
      color: ['#ffffff','#aaccff','#ffaacc','#ccaaff'][Math.floor(Math.random()*4)],
      phase: Math.random() * Math.PI * 2,
      speed: 0.02 + Math.random() * 0.04,
      type: 'star'
    });
  }
  // Inlane lights
  [80,100,120].forEach((y,i) => {
    lights.push({ x:80,  y:700-i*30, r:5, color:'#4488ff', on:false, group:'inlane_l', idx:i });
    lights.push({ x:400, y:700-i*30, r:5, color:'#4488ff', on:false, group:'inlane_r', idx:i });
  });
  return lights;
}

// ─── BARF'S HOUSE TABLE ───────────────────────────────────────────────────────

function buildBarfsHouse() {
  return {
    id: 'barfs_house',
    flippers: [
      { x:120, y:750, angle:-0.52, len:64, w:10, side:'left',  active:false, z:0 },
      { x:360, y:750, angle:Math.PI+0.52, len:64, w:10, side:'right', active:false, z:0 },
      // Kitchen upper flipper
      { x:200, y:380, angle:-0.4,  len:50, w:8, side:'left',  active:false, z:0, upper:true },
    ],
    bumpers: [
      { x:160, y:200, r:26, label:'BARF!',    pts:100, color:'#ff6600', ring:'#ffaa44', hits:0 },
      { x:280, y:180, r:26, label:'SQUAWK!',  pts:150, color:'#44aa00', ring:'#88ff44', hits:0 },
      { x:360, y:220, r:22, label:'CUSTOMER', pts:100, color:'#ff4400', ring:'#ff8844', hits:0 },
      { x:200, y:270, r:20, label:'TABLE 3',  pts:200, color:'#884400', ring:'#cc8844', hits:0 },
      { x:320, y:300, r:20, label:'GRILL IT', pts:200, color:'#cc2200', ring:'#ff6644', hits:0 },
      { x:140, y:310, r:18, label:'HEALTH!',  pts:300, color:'#ff0044', ring:'#ff6688', hits:0 },
    ],
    targets: [
      { x:60,  y:440, w:14, h:30, label:'S', pts:300, color:'#ff8800', hit:false, group:'serve' },
      { x:60,  y:474, w:14, h:30, label:'E', pts:300, color:'#ff8800', hit:false, group:'serve' },
      { x:60,  y:508, w:14, h:30, label:'R', pts:300, color:'#ff8800', hit:false, group:'serve' },
      { x:60,  y:542, w:14, h:30, label:'V', pts:300, color:'#ff8800', hit:false, group:'serve' },
      { x:60,  y:576, w:14, h:30, label:'E', pts:300, color:'#ff8800', hit:false, group:'serve' },
      { x:406, y:440, w:14, h:30, label:'C', pts:400, color:'#00cc44', hit:false, group:'chicken' },
      { x:406, y:474, w:14, h:30, label:'H', pts:400, color:'#00cc44', hit:false, group:'chicken' },
      { x:406, y:508, w:14, h:30, label:'I', pts:400, color:'#00cc44', hit:false, group:'chicken' },
      { x:406, y:542, w:14, h:30, label:'C', pts:400, color:'#00cc44', hit:false, group:'chicken' },
      { x:406, y:576, w:14, h:30, label:'K', pts:400, color:'#00cc44', hit:false, group:'chicken' },
      { x:200, y:460, w:12, h:26, label:'⭐', pts:1000, color:'#ffdd00', hit:false, group:'star' },
      { x:220, y:460, w:12, h:26, label:'⭐', pts:1000, color:'#ffdd00', hit:false, group:'star' },
      { x:240, y:460, w:12, h:26, label:'⭐', pts:1000, color:'#ffdd00', hit:false, group:'star' },
    ],
    ramps: [
      { type:'orbit', side:'left',
        path:[{x:80,y:660},{x:50,y:480},{x:60,y:300},{x:130,y:180}],
        exitX:130,exitY:180,exitVx:3,exitVy:0, z:1, color:'#664400', label:'KITCHEN RAMP' },
      { type:'orbit', side:'right',
        path:[{x:400,y:660},{x:430,y:480},{x:420,y:300},{x:350,y:180}],
        exitX:350,exitY:180,exitVx:-3,exitVy:0, z:1, color:'#446600', label:'ORDER UP!' },
    ],
    wormHoles: [],
    lights: buildBHLights(),
    tableLogic: barfsHouseLogic,
    drawExtra: drawBarfsHouse,
    wallColor: '#1a0800',
    railColor: '#884400',
    fieldColor: '#0a0500',
    inlaneColor: '#553300',
  };
}

function buildBHLights() {
  const lights = [];
  // Restaurant neon signs
  const colors = ['#ff6600','#ffdd00','#ff4400','#44ff00','#ff0044'];
  for (let i = 0; i < 20; i++) {
    lights.push({
      x:70+Math.random()*340, y:120+Math.random()*580,
      r:3+Math.random()*4, color:colors[i%colors.length],
      phase:Math.random()*Math.PI*2, speed:0.03+Math.random()*0.06, type:'neon'
    });
  }
  return lights;
}

// ─── SHOWER DEFENSE TABLE ─────────────────────────────────────────────────────

function buildShowerDefense() {
  return {
    id: 'shower_defense',
    flippers: [
      { x:120, y:750, angle:-0.52, len:64, w:10, side:'left',  active:false, z:0 },
      { x:360, y:750, angle:Math.PI+0.52, len:64, w:10, side:'right', active:false, z:0 },
      // Side tub flipper
      { x:430, y:450, angle:-Math.PI/2, len:52, w:8, side:'right', active:false, z:0, sideFlipper:true },
    ],
    bumpers: [
      { x:160, y:200, r:26, label:'SOAP',    pts:100, color:'#aaddff', ring:'#ddeeff', hits:0 },
      { x:280, y:175, r:26, label:'DUCK!',   pts:150, color:'#ffdd00', ring:'#ffe880', hits:0 },
      { x:360, y:215, r:22, label:'LOOFAH',  pts:100, color:'#ff88aa', ring:'#ffbbcc', hits:0 },
      { x:200, y:265, r:20, label:'PLUNGE',  pts:200, color:'#6688ff', ring:'#aabbff', hits:0 },
      { x:330, y:290, r:20, label:'SCRUB',   pts:200, color:'#44ccff', ring:'#88ddff', hits:0 },
      { x:150, y:310, r:18, label:'RINSE',   pts:300, color:'#00ccff', ring:'#66ddff', hits:0 },
    ],
    targets: [
      { x:60,  y:430, w:14, h:30, label:'D', pts:300, color:'#0088ff', hit:false, group:'drain' },
      { x:60,  y:464, w:14, h:30, label:'R', pts:300, color:'#0088ff', hit:false, group:'drain' },
      { x:60,  y:498, w:14, h:30, label:'A', pts:300, color:'#0088ff', hit:false, group:'drain' },
      { x:60,  y:532, w:14, h:30, label:'I', pts:300, color:'#0088ff', hit:false, group:'drain' },
      { x:60,  y:566, w:14, h:30, label:'N', pts:300, color:'#0088ff', hit:false, group:'drain' },
      { x:406, y:430, w:14, h:30, label:'C', pts:400, color:'#00ccff', hit:false, group:'clean' },
      { x:406, y:464, w:14, h:30, label:'L', pts:400, color:'#00ccff', hit:false, group:'clean' },
      { x:406, y:498, w:14, h:30, label:'E', pts:400, color:'#00ccff', hit:false, group:'clean' },
      { x:406, y:532, w:14, h:30, label:'A', pts:400, color:'#00ccff', hit:false, group:'clean' },
      { x:406, y:566, w:14, h:30, label:'N', pts:400, color:'#00ccff', hit:false, group:'clean' },
      { x:185, y:455, w:12, h:26, label:'💧', pts:800, color:'#44aaff', hit:false, group:'drops' },
      { x:205, y:455, w:12, h:26, label:'💧', pts:800, color:'#44aaff', hit:false, group:'drops' },
      { x:225, y:455, w:12, h:26, label:'💧', pts:800, color:'#44aaff', hit:false, group:'drops' },
      { x:245, y:455, w:12, h:26, label:'💧', pts:800, color:'#44aaff', hit:false, group:'drops' },
    ],
    ramps: [
      { type:'orbit', side:'left',
        path:[{x:80,y:660},{x:52,y:480},{x:58,y:280},{x:140,y:160}],
        exitX:140,exitY:160,exitVx:2.5,exitVy:0, z:1, color:'#004488', label:'SHOWER RAMP' },
      { type:'orbit', side:'right',
        path:[{x:400,y:660},{x:428,y:480},{x:422,y:280},{x:340,y:160}],
        exitX:340,exitY:160,exitVx:-2.5,exitVy:0, z:1, color:'#006688', label:'TUB LOOP' },
    ],
    wormHoles: [],
    lights: buildSDLights(),
    tableLogic: showerDefenseLogic,
    drawExtra: drawShowerDefense,
    wallColor: '#001820',
    railColor: '#005588',
    fieldColor: '#000e16',
    inlaneColor: '#003366',
  };
}

function buildSDLights() {
  const lights = [];
  for (let i = 0; i < 24; i++) {
    lights.push({
      x:65+Math.random()*350, y:120+Math.random()*590,
      r:2+Math.random()*3,
      color:['#aaddff','#44ccff','#00aaff','#66ddff'][i%4],
      phase:Math.random()*Math.PI*2, speed:0.025+Math.random()*0.04, type:'water'
    });
  }
  return lights;
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────

function startLoop() {
  let last = 0;
  function loop(ts) {
    _animId = requestAnimationFrame(loop);
    const dt = Math.min((ts - last) / 16.67, 3);
    last = ts;
    update(dt);
    draw();
    drawDMD();
  }
  _animId = requestAnimationFrame(loop);
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

function update(dt) {
  if (!_pb) return;
  _pb.phaseTimer += dt;
  _pb.dmdTimer   += dt;

  switch(_pb.phase) {
    case 'attract': updateAttract(dt); break;
    case 'plunge':  updatePlunge(dt);  break;
    case 'play':    updatePlay(dt);    break;
    case 'lost':    updateLost(dt);    break;
    case 'gameover':updateGameOver(dt);break;
    case 'scores':  updateScores(dt);  break;
  }

  // Combo timer decay
  if (_pb.combo > 0) {
    _pb.comboTimer -= dt;
    if (_pb.comboTimer <= 0) { _pb.combo = 0; }
  }

  // Mode timer
  if (_pb.modeActive && _pb.modeTimer > 0) {
    _pb.modeTimer -= dt;
    if (_pb.modeTimer <= 0) { endMode(); }
  }

  // Pulse decay
  _pb.lastPulse = _pb.lastPulse.filter(p => { p.life -= dt; return p.life > 0; });

  // Lights animation
  _pb.lights.forEach(l => { l.phase += l.speed * dt; });
}

function updateAttract(dt) {
  if (_pb.phaseTimer > 5 || _keys.space || _keys.left || _keys.right) {
    startBall();
  }
}

function updatePlunge(dt) {
  // Left/right deflect slightly, space charges plunger
  if (_keys.space) {
    _pb.plungerCharge = Math.min(_pb.plungerCharge + 0.5 * dt, PB.PLUNGER_MAX);
  } else if (_pb.plungerCharge > 0) {
    launchBall();
  }
  // Apply flipper physics even in plunge for flicker effect
  updateFlippers(dt);
}

function updatePlay(dt) {
  if (_pb.tilt) return;

  updateFlippers(dt);
  updateBallPhysics(_pb.ball, dt);

  // Multiball
  _pb.extraBalls.forEach(b => updateBallPhysics(b, dt));
  _pb.extraBalls = _pb.extraBalls.filter(b => !b.lost);

  // Check main ball lost
  if (_pb.ball.lost && _pb.extraBalls.length === 0) {
    pbSound('drain');
    _pb.ballsLeft--;
    _pb.phase = 'lost';
    _pb.phaseTimer = 0;
    _pb.dmdAnim = 'ballLost';
    return;
  }

  // Table-specific logic
  _table.tableLogic(dt);

  // Worm hole check for worm_holer
  if (_table.id === 'worm_holer') {
    checkWormHoles(_pb.ball);
    _pb.extraBalls.forEach(b => checkWormHoles(b));
  }
}

function updateLost(dt) {
  if (_pb.phaseTimer > 2) {
    if (_pb.ballsLeft <= 0) {
      endGame();
    } else {
      startBall();
    }
  }
}

function updateGameOver(dt) {
  if (_pb.phaseTimer > 3) {
    saveScore();
    _pb.phase = 'scores';
    _pb.phaseTimer = 0;
  }
}

function updateScores(dt) {
  if ((_keys.space || _keys.left || _keys.right) && _pb.phaseTimer > 1) {
    // Restart
    _pb = freshPBState(_table.id);
    _pb.flippers  = _table.flippers;
    _pb.bumpers   = _table.bumpers;
    _pb.targets   = _table.targets;
    _pb.ramps     = _table.ramps;
    _pb.lights    = _table.lights;
    _pb.wormHoles = _table.wormHoles || [];
    const saved = JSON.parse(localStorage.getItem('pb_scores_' + _table.id) || '[]');
    _pb.highScores = saved;
    _pb.phase = 'attract';
  }
}

// ─── BALL PHYSICS ─────────────────────────────────────────────────────────────

function updateBallPhysics(ball, dt) {
  if (!ball.active || ball.lost) return;

  // Apply gravity (less if on ramp Z > 0)
  const grav = ball.z > 0 ? PB.GRAVITY * 0.6 : PB.GRAVITY;
  ball.vy += grav * dt;

  // Z physics — ball falls back to playfield
  if (ball.z > 0) {
    ball.vz -= 0.05 * dt;
    ball.z = Math.max(0, ball.z + ball.vz * dt);
  }

  // Move
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Friction
  ball.vx *= Math.pow(PB.FRICTION, dt);
  ball.vy *= Math.pow(PB.FRICTION, dt);

  // Wall collisions
  wallCollide(ball);

  // Bumper collisions
  _pb.bumpers.forEach(b => bumperCollide(ball, b));

  // Target collisions
  _pb.targets.forEach(t => targetCollide(ball, t));

  // Flipper collisions
  _pb.flippers.forEach(f => flipperCollide(ball, f));

  // Ramp entry
  _pb.ramps.forEach(r => checkRampEntry(ball, r));

  // Drain check
  if (ball.y > PB.DRAIN_Y) {
    ball.lost = true;
    pbSound('drain');
  }

  // Speed cap
  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd > 30) { ball.vx = ball.vx/spd*30; ball.vy = ball.vy/spd*30; }
  if (spd < PB.MIN_SPEED && ball.z === 0) { ball.vx = 0; ball.vy = 0; }
}

function wallCollide(ball) {
  const r = PB.BALL_R;
  const wallL = 44, wallR = PB.W - 44, wallT = 20, wallB = PB.H - 60;

  // Left wall
  if (ball.x - r < wallL) {
    ball.x = wallL + r;
    ball.vx = Math.abs(ball.vx) * PB.WALL_BOUNCE;
    pbSound('wall');
  }
  // Right wall
  if (ball.x + r > wallR) {
    ball.x = wallR - r;
    ball.vx = -Math.abs(ball.vx) * PB.WALL_BOUNCE;
    pbSound('wall');
  }
  // Top wall
  if (ball.y - r < wallT) {
    ball.y = wallT + r;
    ball.vy = Math.abs(ball.vy) * PB.WALL_BOUNCE;
    pbSound('wall');
  }

  // Drain gap — ball passes between flippers
  if (ball.y > PB.H - 70 && ball.y < PB.H - 40) {
    const gapL = 90, gapR = 390;  // drain gap between flippers
    if (ball.x > gapL && ball.x < gapR) {
      // Passes through to drain — do nothing (will drain)
    } else {
      // Outside the gap — bounce off side gutters
      if (ball.x <= gapL && ball.x - r < wallL) {
        ball.x = wallL + r;
        ball.vx = Math.abs(ball.vx) * PB.WALL_BOUNCE;
      }
    }
  }
}

function bumperCollide(ball, b) {
  const dx = ball.x - b.x, dy = ball.y - b.y;
  const dist = Math.hypot(dx, dy);
  if (dist < b.r + PB.BALL_R) {
    const nx = dx / dist, ny = dy / dist;
    ball.x = b.x + nx * (b.r + PB.BALL_R);
    ball.vx = nx * PB.BUMPER_FORCE;
    ball.vy = ny * PB.BUMPER_FORCE;
    b.hits++;
    const pts = b.pts * _pb.multiplier;
    addScore(pts, b.x, b.y);
    _pb.combo++;
    _pb.comboTimer = 3;
    _pb.lastPulse.push({ x:b.x, y:b.y, r:b.r, life:0.4, maxLife:0.4, color:b.ring });
    pbSound('bumper');
    _table.tableLogic && onBumperHit(b);
  }
}

function targetCollide(ball, t) {
  if (t.hit) return;
  if (ball.x > t.x && ball.x < t.x + t.w && ball.y > t.y && ball.y < t.y + t.h) {
    t.hit = true;
    const pts = t.pts * _pb.multiplier;
    addScore(pts, t.x + t.w/2, t.y + t.h/2);
    _pb.lastPulse.push({ x:t.x+t.w/2, y:t.y+t.h/2, r:20, life:0.3, maxLife:0.3, color:t.color });
    ball.vy = -Math.abs(ball.vy) * 0.7;
    ball.vx += (Math.random() - 0.5) * 2;
    pbSound('target');
    checkTargetGroup(t.group);
  }
}

function checkTargetGroup(group) {
  if (!group) return;
  const groupTargets = _pb.targets.filter(t => t.group === group);
  if (groupTargets.every(t => t.hit)) {
    onGroupComplete(group);
    setTimeout(() => groupTargets.forEach(t => t.hit = false), 1500);
  }
}

function onGroupComplete(group) {
  addScore(5000 * _pb.multiplier, PB.W/2, PB.H/2);
  pbSound('groupComplete');

  if (_table.id === 'worm_holer') {
    if (group === 'wormgate' || group === 'wormgate2') {
      activateWormHole();
    } else if (group === 'multi') {
      startMultiball(2);
    }
  } else if (_table.id === 'barfs_house') {
    if (group === 'serve') { triggerMode('serving', 20, { pts:500 }); }
    else if (group === 'chicken') { triggerMode('chickenRush', 30, { pts:800 }); }
    else if (group === 'star') { _pb.multiplier = Math.min(_pb.multiplier + 1, 5); }
  } else if (_table.id === 'shower_defense') {
    if (group === 'drain') { triggerMode('cloggedDrain', 25, {}); }
    else if (group === 'clean') { triggerMode('deepClean', 20, {}); }
    else if (group === 'drops') { startMultiball(3); }
  }
}

function onBumperHit(b) {
  if (_table.id === 'worm_holer') {
    _pb.tableProgress.bumperHits = (_pb.tableProgress.bumperHits || 0) + 1;
    if (_pb.tableProgress.bumperHits % 20 === 0) startMultiball(2);
  }
}

function flipperCollide(ball, f) {
  // Get flipper endpoints
  const angle = getFlipperAngle(f);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const tx = f.x + cos * f.len, ty = f.y + sin * f.len;

  // Project ball onto flipper line segment
  const dx = tx - f.x, dy = ty - f.y;
  const lenSq = dx*dx + dy*dy;
  let t = ((ball.x - f.x)*dx + (ball.y - f.y)*dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = f.x + t*dx, cy = f.y + t*dy;
  const distX = ball.x - cx, distY = ball.y - cy;
  const dist = Math.hypot(distX, distY);

  if (dist < PB.BALL_R + f.w/2) {
    const nx = distX/dist, ny = distY/dist;
    ball.x = cx + nx * (PB.BALL_R + f.w/2 + 1);
    ball.y = cy + ny * (PB.BALL_R + f.w/2 + 1);
    const dot = ball.vx*nx + ball.vy*ny;
    ball.vx -= 2*dot*nx;
    ball.vy -= 2*dot*ny;
    // Add flipper velocity if active
    if (f.active) {
      const flipVy = f.side === 'left' ? -PB.FLIPPER_FORCE : -PB.FLIPPER_FORCE;
      ball.vy += flipVy;
      ball.vx += f.side === 'left' ? PB.FLIPPER_FORCE * 0.3 : -PB.FLIPPER_FORCE * 0.3;
      pbSound('flipper');
    }
  }
}

function getFlipperAngle(f) {
  const restAngle = f.angle;
  const activeAngle = f.side === 'left' ? restAngle + 0.55 : restAngle - 0.55;
  return f.active ? activeAngle : restAngle;
}

// ─── FLIPPER UPDATE ───────────────────────────────────────────────────────────

function updateFlippers(dt) {
  _pb.flippers.forEach(f => {
    const shouldBeActive = (f.side === 'left' && _keys.left) ||
                           (f.side === 'right' && _keys.right);
    if (f.active !== shouldBeActive) {
      f.active = shouldBeActive;
      if (shouldBeActive) pbSound('flipper');
    }
  });
}

// ─── RAMPS ────────────────────────────────────────────────────────────────────

function checkRampEntry(ball, ramp) {
  if (ball.z > 0) return; // already on ramp
  const entry = ramp.path[0];
  const dx = ball.x - entry.x, dy = ball.y - entry.y;
  if (Math.hypot(dx,dy) < 20) {
    // Check ball has enough speed going the right direction
    if (Math.hypot(ball.vx, ball.vy) > 5) {
      ball.z = 1; ball.vz = 0.5;
      addScore(1000 * _pb.multiplier, entry.x, entry.y);
      pbSound('ramp');
      // Redirect ball along ramp path
      const next = ramp.path[1];
      const ang = Math.atan2(next.y - entry.y, next.x - entry.x);
      const spd = Math.hypot(ball.vx, ball.vy) * 1.1;
      ball.vx = Math.cos(ang) * spd;
      ball.vy = Math.sin(ang) * spd;
      // Schedule exit
      setTimeout(() => {
        if (ball.active && !ball.lost) {
          ball.x = ramp.exitX; ball.y = ramp.exitY;
          ball.vx = ramp.exitVx * 5; ball.vy = ramp.exitVy * 5;
          ball.z = 0; ball.vz = 0;
          addScore(2000 * _pb.multiplier, ramp.exitX, ramp.exitY);
        }
      }, 800);
    }
  }
}

// ─── WORM HOLES ───────────────────────────────────────────────────────────────

function activateWormHole() {
  const inactive = _pb.wormHoles.filter(w => !w.active);
  if (inactive.length) {
    inactive[0].active = true;
    pbSound('wormHoleActivate');
    dmdShow('WORM HOLE OPEN!', 2);
  }
}

function checkWormHoles(ball) {
  _pb.wormHoles.filter(w => w.active).forEach(wh => {
    const d = Math.hypot(ball.x - wh.x, ball.y - wh.y);
    if (d < wh.r + PB.BALL_R) {
      // Teleport!
      const exits = _pb.wormHoles.filter((w2,i) => w2.active && w2 !== wh);
      if (exits.length) {
        const dest = exits[Math.floor(Math.random() * exits.length)];
        ball.x = dest.x; ball.y = dest.y;
        ball.vx = (Math.random() - 0.5) * 8;
        ball.vy = -4 - Math.random() * 4;
        wh.hits++;
        addScore(5000 * _pb.multiplier, dest.x, dest.y);
        pbSound('wormHoleTravel');
        dmdShow('QUANTUM LEAP!', 1.5);
        _pb.lastPulse.push({ x:dest.x, y:dest.y, r:40, life:0.5, maxLife:0.5, color:'#aa00ff' });
      }
    }
  });
}

// ─── TABLE LOGIC (table-specific per-frame) ───────────────────────────────────

function wormHolerLogic(dt) {
  const prog = _pb.tableProgress;
  // Gravity wells — slight pull toward active worm holes
  _pb.wormHoles.filter(w => w.active).forEach(wh => {
    const dx = wh.x - _pb.ball.x, dy = wh.y - _pb.ball.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 120 && dist > wh.r + PB.BALL_R + 5) {
      const pull = 0.08 / dist;
      _pb.ball.vx += dx * pull * dt;
      _pb.ball.vy += dy * pull * dt;
    }
  });
}

function barfsHouseLogic(dt) {
  if (_pb.modeActive === 'serving') {
    // Bumpers worth more, targets auto-reset faster
  } else if (_pb.modeActive === 'chickenRush') {
    // All bumpers worth triple
    _pb.bumpers.forEach(b => b._boostActive = true);
  }
}

function showerDefenseLogic(dt) {
  if (_pb.modeActive === 'cloggedDrain') {
    // Apply "current" — slight rightward drift in upper third
    if (_pb.ball.y < PB.H / 3) {
      _pb.ball.vx += 0.04 * dt;
    }
  }
}

// ─── MODES ────────────────────────────────────────────────────────────────────

function triggerMode(name, duration, data) {
  _pb.modeActive = name;
  _pb.modeTimer  = duration;
  _pb.modeData   = data;
  pbSound('modeStart');
  const labels = {
    serving:      "SERVE IT UP!",
    chickenRush:  "KITCHEN CHAOS!",
    cloggedDrain: "UNCLOG THE DRAIN!",
    deepClean:    "DEEP CLEAN MODE!",
  };
  dmdShow(labels[name] || name.toUpperCase(), 2);
}

function endMode() {
  addScore(10000 * _pb.multiplier, PB.W/2, 400);
  dmdShow('MODE COMPLETE!', 1.5);
  pbSound('modeEnd');
  _pb.modeActive = null;
  _pb.modeData   = {};
}

// ─── MULTIBALL ────────────────────────────────────────────────────────────────

function startMultiball(count) {
  if (_pb.extraBalls.length >= 2) return;
  pbSound('multiball');
  dmdShow('MULTIBALL!', 2);
  for (let i = 0; i < count - 1; i++) {
    _pb.extraBalls.push({
      x: PB.W/2 + (Math.random()-0.5)*60,
      y: 400,
      vx: (Math.random()-0.5)*8,
      vy: -6 - Math.random()*4,
      z: 0, vz: 0,
      active: true, lost: false
    });
  }
  _pb.multiplier = Math.min(_pb.multiplier + 1, 6);
}

// ─── BALL MANAGEMENT ─────────────────────────────────────────────────────────

function startBall() {
  _pb.ball = { x: PB.W - 28, y: PB.H - 120, vx:0, vy:0, z:0, vz:0, active:true, lost:false };
  _pb.extraBalls = [];
  _pb.plungerCharge = 0;
  _pb.launched = false;
  _pb.modeActive = null;
  // Reset targets
  _pb.targets.forEach(t => t.hit = false);
  _pb.phase = 'plunge';
  _pb.phaseTimer = 0;
  dmdShow('PULL AND RELEASE', 0);
}

function launchBall() {
  const force = _pb.plungerCharge;
  _pb.ball.vy = -force;
  _pb.ball.vx = (Math.random()-0.5) * 0.5;
  _pb.plungerCharge = 0;
  _pb.launched = true;
  _pb.phase = 'play';
  pbSound('launch');
}

function endGame() {
  _pb.phase = 'gameover';
  _pb.phaseTimer = 0;
  dmdShow('GAME OVER', 0);
  pbSound('gameOver');
}

function saveScore() {
  const entry = { score: _pb.score, date: new Date().toLocaleDateString() };
  _pb.highScores.push(entry);
  _pb.highScores.sort((a,b) => b.score - a.score);
  _pb.highScores = _pb.highScores.slice(0, 8);
  localStorage.setItem('pb_scores_' + _table.id, JSON.stringify(_pb.highScores));

  // Match sequence — check last 2 digits of score vs random number
  const match = Math.floor(Math.random() * 10);
  const scoreEnd = _pb.score % 10;
  _pb.lastMatch = { match, won: scoreEnd === match };
}

function addScore(pts, x, y) {
  _pb.score += Math.floor(pts);
  _pb.lastPulse.push({ x, y, r:0, life:1.0, maxLife:1.0, pts:Math.floor(pts), isScore:true });
}

// ─── DMD ──────────────────────────────────────────────────────────────────────

function dmdShow(text, duration) {
  _pb.dmdText = text;
  _pb.dmdAnim = 'flash';
  if (duration > 0) setTimeout(() => { if (_pb.dmdAnim==='flash') _pb.dmdAnim='play'; }, duration*1000);
}

function drawDMD() {
  if (!_dctx) return;
  const W = PB.W, H = PB.DMD_H;
  _dctx.fillStyle = '#050302';
  _dctx.fillRect(0, 0, W, H);

  // Dot matrix grid
  const dotSize = 3, gap = 1, cols = Math.floor(W/(dotSize+gap)), rows = Math.floor(H/(dotSize+gap));

  switch(_pb.dmdAnim || 'attract') {
    case 'attract':   drawDMDAttract(cols, rows, dotSize, gap); break;
    case 'play':      drawDMDPlay(cols, rows, dotSize, gap);    break;
    case 'flash':     drawDMDFlash(cols, rows, dotSize, gap);   break;
    case 'ballLost':  drawDMDBallLost(cols, rows, dotSize, gap);break;
    default:          drawDMDPlay(cols, rows, dotSize, gap);    break;
  }

  // Scanline overlay
  _dctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < H; y += 2) _dctx.fillRect(0, y, W, 1);

  // Border
  _dctx.strokeStyle = '#333';
  _dctx.lineWidth = 2;
  _dctx.strokeRect(1, 1, W-2, H-2);
}

function dmdDot(col, row, dotSize, gap, brightness, color) {
  const x = col * (dotSize+gap) + 2;
  const y = row * (dotSize+gap) + 2;
  const alpha = Math.max(0.05, brightness);
  _dctx.fillStyle = color || `rgba(255,140,20,${alpha})`;
  _dctx.fillRect(x, y, dotSize, dotSize);
}

function drawDMDAttract(cols, rows, ds, gap) {
  const t = _pb.dmdTimer;
  const ac = _tableDef?.accentColor || '#ff8c14';
  const sc = _tableDef?.secondColor || '#ff4400';
  const name = (_tableDef?.name || 'PINBALL BUDDY').toUpperCase();

  // Background wave
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const wave = 0.08 + 0.07 * Math.sin(c * 0.3 + t * 2 + r * 0.2);
      dmdDot(c, r, ds, gap, wave, null);
    }
  }

  // Table name
  drawDMDText(name, ds, gap, cols, Math.floor(rows*0.35), 2.2, '#ffaa20');

  // Press start
  if (Math.sin(t * 3) > 0) {
    drawDMDText('PRESS ANY BUTTON', ds, gap, cols, Math.floor(rows*0.72), 1.1, '#ff8c14');
  }

  // High score
  if (_pb.highScores.length > 0) {
    drawDMDText('HI ' + _pb.highScores[0].score.toLocaleString(), ds, gap, cols, Math.floor(rows*0.88), 1.0, '#ff6600');
  }
}

function drawDMDPlay(cols, rows, ds, gap) {
  const ac = _tableDef?.accentColor || '#ff8c14';
  // Background — subtle dot grid
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      dmdDot(c, r, ds, gap, 0.06, null);

  // Score (large)
  drawDMDText(_pb.score.toLocaleString(), ds, gap, cols, Math.floor(rows*0.35), 2.0, '#ffcc00');

  // Ball indicator
  const ballStr = 'BALL ' + _pb.ballNum + ' / 3';
  drawDMDText(ballStr, ds, gap, cols, Math.floor(rows*0.68), 1.0, '#ff8c14');

  // Multiplier
  if (_pb.multiplier > 1) {
    drawDMDText(_pb.multiplier + 'X', ds, gap, cols, Math.floor(rows*0.85), 1.0, '#ff4400');
  }

  // Mode name
  if (_pb.modeActive) {
    const modeLabel = _pb.modeActive.toUpperCase().replace(/([A-Z])/g,' $1').trim();
    drawDMDText(modeLabel, ds, gap, cols, Math.floor(rows*0.1), 0.9, '#ff0088');
  }
}

function drawDMDFlash(cols, rows, ds, gap) {
  const t = _pb.dmdTimer;
  const pulse = Math.abs(Math.sin(t * 8));
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++)
      dmdDot(c, r, ds, gap, pulse * 0.15, null);

  drawDMDText(_pb.dmdText || '', ds, gap, cols, Math.floor(rows*0.45), 1.6, `rgba(255,220,50,${0.7+pulse*0.3})`);
}

function drawDMDBallLost(cols, rows, ds, gap) {
  const t = _pb.dmdTimer;
  // Drain animation — dots falling
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const fall = (r + t * 8) % rows;
      dmdDot(c, r, ds, gap, fall/rows * 0.3, null);
    }
  }
  drawDMDText('BALL LOST!', ds, gap, cols, Math.floor(rows*0.4), 1.6, '#ff3300');
  if (_pb.ballsLeft > 0) {
    drawDMDText(_pb.ballsLeft + ' BALL' + (_pb.ballsLeft>1?'S':'') + ' REMAINING', ds, gap, cols, Math.floor(rows*0.75), 0.9, '#ff8800');
  }
}

// Simple pixel-font text renderer for DMD
const DMD_FONT = {
  '0':[[1,1],[1,0,1],[1,0,1],[1,0,1],[1,1]],'1':[[0,1],[1,1],[0,1],[0,1],[1,1,1]],
  '2':[[1,1],[0,0,1],[0,1,1],[1,0,0],[1,1,1]],'3':[[1,1],[0,0,1],[0,1,1],[0,0,1],[1,1]],
  '4':[[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]],'5':[[1,1,1],[1],[1,1],[0,0,1],[1,1]],
  '6':[[0,1,1],[1],[1,1],[1,0,1],[1,1]],'7':[[1,1,1],[0,0,1],[0,1],[0,1],[0,1]],
  '8':[[1,1],[1,0,1],[1,1],[1,0,1],[1,1]],'9':[[1,1],[1,0,1],[1,1],[0,0,1],[1,1]],
  'A':[[0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],'B':[[1,1],[1,0,1],[1,1],[1,0,1],[1,1]],
  'C':[[0,1,1],[1],[1],[1],[0,1,1]],'D':[[1,1],[1,0,1],[1,0,1],[1,0,1],[1,1]],
  'E':[[1,1,1],[1],[1,1],[1],[1,1,1]],'F':[[1,1,1],[1],[1,1],[1],[1]],
  'G':[[0,1,1],[1],[1,0,1,1],[1,0,1],[0,1,1]],'H':[[1,0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
  'I':[[1,1,1],[0,1],[0,1],[0,1],[1,1,1]],'J':[[0,0,1],[0,0,1],[0,0,1],[1,0,1],[0,1]],
  'K':[[1,0,1],[1,0,1],[1,1],[1,0,1],[1,0,1]],'L':[[1],[1],[1],[1],[1,1,1]],
  'M':[[1,0,0,0,1],[1,1,0,1,1],[1,0,1,0,1],[1,0,0,0,1],[1,0,0,0,1]],
  'N':[[1,0,1],[1,1,1],[1,1,1],[1,0,1],[1,0,1]],'O':[[0,1],[1,0,1],[1,0,1],[1,0,1],[0,1]],
  'P':[[1,1],[1,0,1],[1,1],[1],[1]],'Q':[[0,1],[1,0,1],[1,0,1],[1,1,1],[0,0,1]],
  'R':[[1,1],[1,0,1],[1,1],[1,0,1],[1,0,1]],'S':[[0,1,1],[1],[0,1,0],[0,0,1],[1,1,0]],
  'T':[[1,1,1],[0,1],[0,1],[0,1],[0,1]],'U':[[1,0,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
  'V':[[1,0,1],[1,0,1],[1,0,1],[0,1,0],[0,1]],'W':[[1,0,0,0,1],[1,0,0,0,1],[1,0,1,0,1],[1,1,0,1,1],[1,0,0,0,1]],
  'X':[[1,0,1],[1,0,1],[0,1,0],[1,0,1],[1,0,1]],'Y':[[1,0,1],[1,0,1],[0,1,0],[0,1],[0,1]],
  'Z':[[1,1,1],[0,0,1],[0,1,0],[1,0,0],[1,1,1]],' ':[[0],[0],[0],[0],[0]],
  '!':[[0,1],[0,1],[0,1],[0,0],[0,1]],'/':[[0,0,1],[0,0,1],[0,1],[1],[1]],
  "'":[[0,1],[0,1],[0],[0],[0]],':':[[0],[0,1],[0],[0,1],[0]],
  ',':[[0,0],[0,0],[0,0],[0,1],[1,0]],'.':[[0],[0],[0],[0],[1]],
  '-':[[0,0,0],[0,0,0],[1,1,1],[0,0,0],[0,0,0]],'×':[[1,0,1],[0,1,0],[0,1,0],[0,1,0],[1,0,1]],
  'X':[[1,0,1],[0,1,0],[0,1,0],[0,1,0],[1,0,1]],'★':[[0,1,0],[1,1,1],[0,1,0],[1,0,1],[0,0,0]],
  '💧':[[0,1,0],[1,1,1],[1,1,1],[1,1,1],[0,1,0]],'⭐':[[0,1,0],[1,1,1],[0,1,0],[1,0,1],[0,0,0]],
};

function drawDMDText(text, ds, gap, cols, startRow, scale, color) {
  const charW = Math.ceil(4 * scale), charH = Math.ceil(5 * scale), charGap = Math.ceil(1 * scale);
  const totalW = text.length * (charW + charGap);
  let startCol = Math.floor((cols - totalW / (ds + gap)) / 2);

  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci].toUpperCase();
    const glyph = DMD_FONT[ch] || DMD_FONT[' '];
    for (let r = 0; r < glyph.length; r++) {
      const row = glyph[r];
      for (let c = 0; c < (row?.length || 0); c++) {
        if (row[c]) {
          for (let sr = 0; sr < Math.ceil(scale); sr++) {
            for (let sc2 = 0; sc2 < Math.ceil(scale); sc2++) {
              dmdDot(
                startCol + ci*(charW+charGap) + c*Math.ceil(scale) + sc2,
                startRow + r*Math.ceil(scale) + sr,
                ds, gap, 1, color
              );
            }
          }
        }
      }
    }
  }
}

// ─── DRAW ─────────────────────────────────────────────────────────────────────

function draw() {
  if (!_ctx || !_table) return;
  const ctx = _ctx;
  ctx.clearRect(0, 0, PB.W, PB.H);

  drawTable(ctx);
  drawLights(ctx);
  drawRamps(ctx);
  drawBumpers(ctx);
  drawTargets(ctx);
  drawWormHolesOnField(ctx);
  _table.drawExtra(ctx);
  drawFlippers(ctx);
  drawPlunger(ctx);
  drawBall(ctx, _pb.ball);
  _pb.extraBalls.forEach(b => drawBall(ctx, b));
  drawPulses(ctx);
  drawHUD(ctx);
}

function drawTable(ctx) {
  const t = _table;
  // Field
  ctx.fillStyle = t.fieldColor || '#000008';
  ctx.fillRect(0, 0, PB.W, PB.H);

  // Side walls
  ctx.fillStyle = t.wallColor || '#0a0a2a';
  ctx.fillRect(0, 0, 44, PB.H);
  ctx.fillRect(PB.W - 44, 0, 44, PB.H);

  // Rail highlight
  ctx.fillStyle = t.railColor || '#002288';
  ctx.fillRect(40, 0, 4, PB.H);
  ctx.fillRect(PB.W - 44, 0, 4, PB.H);

  // Drain gutters — angled inward at bottom
  ctx.fillStyle = t.wallColor;
  // Left gutter
  ctx.beginPath();
  ctx.moveTo(44, PB.H - 60);
  ctx.lineTo(44, PB.H);
  ctx.lineTo(120, PB.H - 40);
  ctx.lineTo(100, PB.H - 60);
  ctx.fill();
  // Right gutter
  ctx.beginPath();
  ctx.moveTo(PB.W-44, PB.H - 60);
  ctx.lineTo(PB.W-44, PB.H);
  ctx.lineTo(PB.W-120, PB.H - 40);
  ctx.lineTo(PB.W-100, PB.H - 60);
  ctx.fill();

  // Plunger lane (right side)
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(PB.W - 44, PB.H - 200, 40, 200);

  // Inlane guides
  ctx.strokeStyle = t.railColor || '#002288';
  ctx.lineWidth = 3;
  // Left inlane
  ctx.beginPath();
  ctx.moveTo(90, PB.H - 60);
  ctx.lineTo(90, PB.H - 200);
  ctx.stroke();
  // Right inlane
  ctx.beginPath();
  ctx.moveTo(PB.W - 90, PB.H - 60);
  ctx.lineTo(PB.W - 90, PB.H - 200);
  ctx.stroke();

  // Center drain warning line
  ctx.strokeStyle = 'rgba(255,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(44, PB.DRAIN_Y - PB.H + 10);
  ctx.lineTo(PB.W - 44, PB.DRAIN_Y - PB.H + 10);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawLights(ctx) {
  _pb.lights.forEach(l => {
    const brightness = 0.3 + 0.4 * Math.abs(Math.sin(l.phase));
    ctx.globalAlpha = brightness;
    ctx.fillStyle = l.color;
    ctx.beginPath();
    ctx.arc(l.x, l.y, l.r, 0, Math.PI*2);
    ctx.fill();
    // Glow
    ctx.globalAlpha = brightness * 0.2;
    ctx.beginPath();
    ctx.arc(l.x, l.y, l.r * 2.5, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });
}

function drawRamps(ctx) {
  _pb.ramps.forEach(r => {
    ctx.strokeStyle = r.color || '#224488';
    ctx.lineWidth = 10;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    r.path.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.stroke();
    // Ramp highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    r.path.forEach((p,i) => i===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Label at midpoint
    if (r.label) {
      const mid = r.path[Math.floor(r.path.length/2)];
      ctx.fillStyle = 'rgba(200,200,255,0.6)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(r.label, mid.x, mid.y);
    }
  });
}

function drawBumpers(ctx) {
  _pb.bumpers.forEach(b => {
    const pulse = _pb.lastPulse.find(p => Math.hypot(p.x-b.x, p.y-b.y) < 5);
    const glow = pulse ? (pulse.life / pulse.maxLife) : 0;

    // Outer ring glow
    if (glow > 0) {
      ctx.shadowColor = b.ring;
      ctx.shadowBlur = 20 * glow;
    }
    ctx.strokeStyle = b.ring;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + 4, 0, Math.PI*2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Body
    const grad = ctx.createRadialGradient(b.x-b.r*0.3, b.y-b.r*0.3, 0, b.x, b.y, b.r);
    grad.addColorStop(0, lightenHex(b.color, 0.4));
    grad.addColorStop(1, b.color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
    ctx.fill();

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(6, b.r*0.5)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x, b.y);

    // Hit count tiny
    if (b.hits > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '6px monospace';
      ctx.fillText(b.hits, b.x + b.r * 0.6, b.y - b.r * 0.6);
    }
  });
}

function drawTargets(ctx) {
  _pb.targets.forEach(t => {
    ctx.fillStyle = t.hit ? 'rgba(100,100,100,0.3)' : t.color;
    ctx.shadowColor = t.hit ? 'transparent' : t.color;
    ctx.shadowBlur  = t.hit ? 0 : 6;
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = t.hit ? '#333' : '#fff';
    ctx.font = `bold ${Math.min(t.w, t.h) * 0.7}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.label, t.x + t.w/2, t.y + t.h/2);
  });
}

function drawWormHolesOnField(ctx) {
  if (_table.id !== 'worm_holer') return;
  _pb.wormHoles.forEach(wh => {
    const t = _pb.dmdTimer;
    const spin = t * (wh.active ? 3 : 0.5);
    // Spiral
    for (let i = 0; i < (wh.active ? 6 : 3); i++) {
      const a = spin + i * (Math.PI*2/6);
      const ir = wh.active ? wh.r * 0.3 : wh.r * 0.1;
      const or = wh.r;
      ctx.strokeStyle = wh.active
        ? `hsla(${270 + i*20}, 100%, 60%, ${0.6 - i*0.08})`
        : `rgba(100,100,200,${0.2 - i*0.05})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(wh.x, wh.y, ir + (or-ir)*(i/6), a, a + Math.PI*2*(1-i/8));
      ctx.stroke();
    }
    // Center
    ctx.fillStyle = wh.active ? wh.color : '#111';
    ctx.shadowColor = wh.active ? wh.color : 'transparent';
    ctx.shadowBlur  = wh.active ? 15 : 0;
    ctx.beginPath();
    ctx.arc(wh.x, wh.y, wh.r * 0.35, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Label
    ctx.fillStyle = wh.active ? '#fff' : '#444';
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(wh.label, wh.x, wh.y + wh.r + 10);
  });
}

// Table-specific extra drawing
function drawWormHoler(ctx) {
  // Star field shimmer (already done via lights) + nebula background
  const t = _pb.dmdTimer;
  const grad = ctx.createRadialGradient(PB.W/2, PB.H*0.3, 20, PB.W/2, PB.H*0.3, 200);
  grad.addColorStop(0, `rgba(40,0,80,${0.08 + 0.03*Math.sin(t)})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PB.W, PB.H);
}

function drawBarfsHouse(ctx) {
  const t = _pb.dmdTimer;
  // Restaurant ambiance — warm glow in center
  const grad = ctx.createRadialGradient(PB.W/2, PB.H*0.4, 10, PB.W/2, PB.H*0.4, 180);
  grad.addColorStop(0, `rgba(80,30,0,${0.1 + 0.04*Math.sin(t*2)})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PB.W, PB.H);

  // "BARF'S HOUSE" title on wall
  ctx.fillStyle = 'rgba(255,100,0,0.15)';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.fillText("BARF'S HOUSE", PB.W/2, 85);
  // Laugh track dots
  if (_pb.modeActive || _pb.combo > 3) {
    for (let i = 0; i < 7; i++) {
      const blink = Math.sin(t * 5 + i) > 0;
      ctx.fillStyle = blink ? 'rgba(255,200,0,0.6)' : 'rgba(100,80,0,0.3)';
      ctx.beginPath();
      ctx.arc(100 + i * 45, 70, 5, 0, Math.PI*2);
      ctx.fill();
    }
  }
}

function drawShowerDefense(ctx) {
  const t = _pb.dmdTimer;
  // Water shimmer
  const grad = ctx.createRadialGradient(PB.W/2, PB.H*0.25, 10, PB.W/2, PB.H*0.25, 200);
  grad.addColorStop(0, `rgba(0,80,160,${0.08 + 0.04*Math.sin(t*1.5)})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PB.W, PB.H);
  // Grime meter
  const grime = (_pb.tableProgress.grime || 0);
  if (grime > 0) {
    ctx.fillStyle = `rgba(60,40,0,${Math.min(grime/100, 0.4)})`;
    ctx.fillRect(0, 0, PB.W, PB.H);
  }
  // Cleanliness %
  const clean = Math.max(0, 100 - grime);
  ctx.fillStyle = 'rgba(0,200,255,0.4)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`CLEAN: ${Math.round(clean)}%`, 50, 15);
}

function drawFlippers(ctx) {
  _pb.flippers.forEach(f => {
    const angle = getFlipperAngle(f);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const tx = f.x + cos * f.len, ty = f.y + sin * f.len;

    const ac = _tableDef?.accentColor || '#4488ff';
    ctx.strokeStyle = f.active ? '#fff' : ac;
    ctx.lineWidth = f.w;
    ctx.lineCap = 'round';
    ctx.shadowColor = f.active ? '#fff' : ac;
    ctx.shadowBlur = f.active ? 12 : 4;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Pivot dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.w/2 + 2, 0, Math.PI*2);
    ctx.fill();
  });
}

function drawPlunger(ctx) {
  if (_pb.phase !== 'plunge') return;
  const x = PB.W - 22, baseY = PB.H - 80, maxH = 80;
  const charge = _pb.plungerCharge / PB.PLUNGER_MAX;

  // Guide
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, baseY - maxH);
  ctx.stroke();

  // Charge bar
  const barH = charge * maxH;
  const col = charge < 0.5 ? '#44ff88' : charge < 0.8 ? '#ffcc00' : '#ff4400';
  ctx.strokeStyle = col;
  ctx.lineWidth = 8;
  ctx.shadowColor = col;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, baseY - barH);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Plunger tip
  ctx.fillStyle = '#aaa';
  ctx.beginPath();
  ctx.arc(x, baseY - barH, 7, 0, Math.PI*2);
  ctx.fill();

  // Hold space hint
  if (_pb.plungerCharge < 1) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('HOLD SPACE / LAUNCH', PB.W/2, PB.H - 20);
  }
}

function drawBall(ctx, ball) {
  if (!ball.active || ball.lost) return;

  // Ball is semi-transparent if on a ramp (Z > 0)
  const alpha = ball.z > 0 ? 0.55 : 1;
  const radius = PB.BALL_R * (1 + ball.z * 0.08);

  ctx.globalAlpha = alpha;

  // Drop shadow (larger when elevated)
  if (ball.z > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(ball.x + ball.z*3, ball.y + ball.z*5, radius*0.8, radius*0.4, 0, 0, Math.PI*2);
    ctx.fill();
  }

  const ballColor = _tableDef?.ballColor || '#c0e0ff';
  // Ball gradient
  const grad = ctx.createRadialGradient(
    ball.x - radius*0.3, ball.y - radius*0.3, 0,
    ball.x, ball.y, radius
  );
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.3, ballColor);
  grad.addColorStop(1, darkenHex(ballColor, 0.5));
  ctx.fillStyle = grad;
  ctx.shadowColor = ballColor;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, Math.PI*2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Specular highlight
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(ball.x - radius*0.3, ball.y - radius*0.3, radius*0.28, 0, Math.PI*2);
  ctx.fill();

  ctx.globalAlpha = 1;
}

function drawPulses(ctx) {
  _pb.lastPulse.forEach(p => {
    const pct = p.life / p.maxLife;
    if (p.isScore) {
      ctx.globalAlpha = pct;
      ctx.fillStyle = '#ffdd00';
      ctx.font = `bold ${10 + (1-pct)*6}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('+' + (p.pts || '').toLocaleString(), p.x, p.y - (1-pct)*30);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = pct * 0.5;
      ctx.strokeStyle = p.color || '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + (1-pct)*20, 0, Math.PI*2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
}

function drawHUD(ctx) {
  // Score top of playfield
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, PB.W, 20);
  ctx.fillStyle = '#ffdd00';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText((_tableDef?.name || 'PINBALL'), 50, 14);
  ctx.textAlign = 'right';
  ctx.fillText(_pb.score.toLocaleString(), PB.W - 50, 14);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText('BALL ' + _pb.ballNum + '/3', PB.W/2, 14);

  // Game over overlay
  if (_pb.phase === 'gameover' || _pb.phase === 'scores') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, PB.W, PB.H);
    ctx.fillStyle = '#ffdd00';
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', PB.W/2, PB.H/2 - 80);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(_pb.score.toLocaleString(), PB.W/2, PB.H/2 - 40);

    if (_pb.phase === 'scores') {
      // High scores
      ctx.font = 'bold 14px monospace';
      ctx.fillStyle = '#ffaa00';
      ctx.fillText('HIGH SCORES', PB.W/2, PB.H/2 + 10);
      _pb.highScores.slice(0,5).forEach((s,i) => {
        ctx.fillStyle = i===0 ? '#ffdd00' : '#888';
        ctx.font = `${i===0?'bold ':''} 12px monospace`;
        ctx.fillText(`${i+1}. ${s.score.toLocaleString()}`, PB.W/2, PB.H/2 + 30 + i*18);
      });
      // Match
      if (_pb.lastMatch) {
        const m = _pb.lastMatch;
        ctx.fillStyle = m.won ? '#44ff88' : '#888';
        ctx.font = '11px monospace';
        ctx.fillText(m.won ? `MATCH! FREE GAME!` : `MATCH: ${m.match} — No match`, PB.W/2, PB.H/2 + 130);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '10px monospace';
      ctx.fillText('PRESS ANY BUTTON TO PLAY AGAIN', PB.W/2, PB.H - 30);
    }
  }

  // Lost ball overlay
  if (_pb.phase === 'lost') {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, PB.H/2 - 30, PB.W, 60);
    ctx.fillStyle = '#ff4400';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BALL LOST!', PB.W/2, PB.H/2 + 6);
  }

  // Mode timer bar
  if (_pb.modeActive && _pb.modeTimer > 0) {
    const maxT = 30;
    const pct = _pb.modeTimer / maxT;
    ctx.fillStyle = 'rgba(255,100,0,0.3)';
    ctx.fillRect(44, PB.H - 18, (PB.W-88) * pct, 6);
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth = 1;
    ctx.strokeRect(44, PB.H - 18, PB.W-88, 6);
  }
}

// ─── AUDIO ────────────────────────────────────────────────────────────────────

function initAudio() {
  try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch(e) { _audioCtx = null; }
}

function pbSound(name) {
  if (!_audioCtx) return;
  try { _audioCtx.resume(); } catch(e) {}
  const ac = _audioCtx;
  const now = ac.currentTime;

  const g = ac.createGain();
  g.connect(ac.destination);

  switch(name) {
    case 'flipper': {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(180, now); o.frequency.exponentialRampToValueAtTime(80, now+0.08);
      g.gain.setValueAtTime(0.18, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.1);
      o.connect(g); o.start(now); o.stop(now+0.1); break;
    }
    case 'bumper': {
      const o = ac.createOscillator(); const o2 = ac.createOscillator();
      o.type='square'; o2.type='sine';
      o.frequency.setValueAtTime(400, now); o.frequency.exponentialRampToValueAtTime(200, now+0.12);
      o2.frequency.setValueAtTime(800, now); o2.frequency.exponentialRampToValueAtTime(400, now+0.08);
      g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.15);
      o.connect(g); o2.connect(g); o.start(now); o.stop(now+0.15); o2.start(now); o2.stop(now+0.1); break;
    }
    case 'target': {
      const o = ac.createOscillator(); o.type='square';
      o.frequency.setValueAtTime(600, now); o.frequency.exponentialRampToValueAtTime(900, now+0.05);
      g.gain.setValueAtTime(0.14, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.12);
      o.connect(g); o.start(now); o.stop(now+0.12); break;
    }
    case 'wall': {
      const o = ac.createOscillator(); o.type='sawtooth';
      o.frequency.setValueAtTime(120, now);
      g.gain.setValueAtTime(0.08, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.06);
      o.connect(g); o.start(now); o.stop(now+0.06); break;
    }
    case 'ramp': {
      [300,400,500,650].forEach((freq, i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sine'; o.frequency.value = freq;
        og.gain.setValueAtTime(0, now+i*0.06); og.gain.linearRampToValueAtTime(0.15, now+i*0.06+0.04);
        og.gain.exponentialRampToValueAtTime(0.001, now+i*0.06+0.12);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.06); o.stop(now+i*0.06+0.15);
      }); break;
    }
    case 'drain': {
      const o = ac.createOscillator(); o.type='sawtooth';
      o.frequency.setValueAtTime(200, now); o.frequency.exponentialRampToValueAtTime(40, now+0.5);
      g.gain.setValueAtTime(0.3, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.6);
      o.connect(g); o.start(now); o.stop(now+0.6); break;
    }
    case 'launch': {
      const o = ac.createOscillator(); o.type='sawtooth';
      o.frequency.setValueAtTime(80, now); o.frequency.exponentialRampToValueAtTime(400, now+0.2);
      g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.25);
      o.connect(g); o.start(now); o.stop(now+0.25); break;
    }
    case 'groupComplete': {
      [523,659,784,1047].forEach((f,i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sine'; o.frequency.value=f;
        og.gain.setValueAtTime(0.2, now+i*0.08); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.08+0.2);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.08); o.stop(now+i*0.08+0.25);
      }); break;
    }
    case 'wormHoleActivate': {
      for (let i=0; i<8; i++) {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sine'; o.frequency.setValueAtTime(100+i*50, now+i*0.05);
        o.frequency.exponentialRampToValueAtTime(800, now+i*0.05+0.3);
        og.gain.setValueAtTime(0.12, now+i*0.05); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.05+0.35);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.05); o.stop(now+i*0.05+0.4);
      } break;
    }
    case 'wormHoleTravel': {
      const o = ac.createOscillator(); o.type='sawtooth';
      o.frequency.setValueAtTime(1200, now); o.frequency.exponentialRampToValueAtTime(80, now+0.4);
      g.gain.setValueAtTime(0.25, now); g.gain.exponentialRampToValueAtTime(0.001, now+0.45);
      o.connect(g); o.start(now); o.stop(now+0.45); break;
    }
    case 'multiball': {
      [300,400,500,600,700,800].forEach((f,i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='square'; o.frequency.value=f;
        og.gain.setValueAtTime(0.12, now+i*0.05); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.05+0.15);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.05); o.stop(now+i*0.05+0.2);
      }); break;
    }
    case 'modeStart': {
      [400,600,800,1000].forEach((f,i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sawtooth'; o.frequency.value=f;
        og.gain.setValueAtTime(0.15, now+i*0.06); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.06+0.18);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.06); o.stop(now+i*0.06+0.2);
      }); break;
    }
    case 'modeEnd': {
      [1000,800,600,400,200].forEach((f,i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sine'; o.frequency.value=f;
        og.gain.setValueAtTime(0.15, now+i*0.07); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.07+0.2);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.07); o.stop(now+i*0.07+0.25);
      }); break;
    }
    case 'gameOver': {
      [400,350,300,250,200,150].forEach((f,i) => {
        const o = ac.createOscillator(); const og = ac.createGain();
        o.type='sawtooth'; o.frequency.value=f;
        og.gain.setValueAtTime(0.2, now+i*0.15); og.gain.exponentialRampToValueAtTime(0.001, now+i*0.15+0.25);
        o.connect(og); og.connect(ac.destination); o.start(now+i*0.15); o.stop(now+i*0.15+0.3);
      }); break;
    }
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function lightenHex(hex, amt) {
  let r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  r=Math.min(255,r+(255-r)*amt); g=Math.min(255,g+(255-g)*amt); b=Math.min(255,b+(255-b)*amt);
  return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
}
function darkenHex(hex, amt) {
  let r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  r=Math.max(0,r*(1-amt)); g=Math.max(0,g*(1-amt)); b=Math.max(0,b*(1-amt));
  return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('pbStyles')) return;
  const s = document.createElement('style');
  s.id = 'pbStyles';
  s.textContent = `
.pb-overlay {
  position:fixed;inset:0;background:rgba(0,0,0,0.92);
  display:flex;align-items:center;justify-content:center;
  z-index:9000;backdrop-filter:blur(4px);
}
.pb-shell {
  display:flex;flex-direction:column;align-items:center;
  position:relative;gap:0;user-select:none;
  max-height:100vh;overflow:hidden;
}
.pb-dmd-wrap {
  width:${PB.W}px;background:#050302;border:2px solid #333;
  border-bottom:none;border-radius:6px 6px 0 0;overflow:hidden;flex-shrink:0;
}
#pbDMD { display:block; }
.pb-field-wrap {
  position:relative;flex-shrink:0;
}
#pbCanvas {
  display:block;border:2px solid #222;border-top:none;
  max-height:calc(100vh - ${PB.DMD_H + 70}px);
}
.pb-controls {
  display:flex;justify-content:space-between;align-items:center;
  background:#0a0a0a;border:2px solid #222;border-top:1px solid #333;
  padding:6px 8px;gap:4px;width:100%;box-sizing:border-box;
}
.pb-btn {
  font-family:monospace;font-weight:bold;font-size:13px;
  padding:10px 0;border:2px solid #444;border-radius:6px;
  background:#111;color:#fff;cursor:pointer;
  transition:background 0.08s,border-color 0.08s;
  -webkit-tap-highlight-color:transparent;
  touch-action:manipulation;
}
.pb-btn:active, .pb-btn:focus { background:#333;border-color:#888;outline:none; }
.pb-btn-left  { flex:2;text-align:left;padding-left:14px; }
.pb-btn-right { flex:2;text-align:right;padding-right:14px; }
.pb-btn-launch { flex:1;text-align:center;font-size:10px;color:#aaa; }
.pb-close {
  position:absolute;top:-2px;right:-40px;
  width:32px;height:32px;border-radius:50%;
  border:1px solid #555;background:rgba(0,0,0,0.7);
  color:#aaa;cursor:pointer;font-size:14px;
  display:flex;align-items:center;justify-content:center;
  z-index:10;
}
.pb-close:hover { border-color:#fff;color:#fff; }
@media (max-width:560px) {
  .pb-close { right:4px;top:4px; }
  .pb-btn { font-size:11px;padding:8px 0; }
}
  `;
  document.head.appendChild(s);
}
