/**
 * Pinball Buddy v2 — Complete rewrite fixing all reported issues
 * ==============================================================
 * FIXED: Flipper gap (22px — ball just fits), plunger deflector,
 *        DMD always visible above canvas, dramatic bumper FX,
 *        unique table layouts with slingshots/ramps/locks/kickers
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PB = {
  W:480, H:820,
  BALL_R:11,
  GRAVITY:0.28,
  FRICTION:0.9988,
  WALL_BOUNCE:0.58,
  BUMPER_FORCE:10,
  FLIPPER_FORCE:20,
  PLUNGER_MAX:22,
  MIN_SPEED:0.06,
  FPS:60,
};

// Playfield walls
const wallL=44, wallR=436, wallT=18;
// ── FLIPPER GEOMETRY (canvas: y increases DOWN) ──────────────────────────────
// LEFT flipper:  pivot=(157,748), REST angle=+0.44 (tip DOWN-right), ACTIVE=-0.44 (tip UP-right)
// RIGHT flipper: pivot=(323,748), REST angle=PI-0.44 (tip DOWN-left), ACTIVE=PI+0.44 (tip UP-left)
// REST tips at y≈782 (BELOW pivot), ACTIVE tips at y≈714 (ABOVE pivot)
// Gap between tips: 21px (ball diameter 22px — ball barely passes, gutters on sides)
const FL = {
  leftX:157, rightX:323, y:748, len:80, w:12,
  REST_L:   0.44,              // left flipper rest angle
  ACT_L:   -0.44,              // left flipper active angle
  REST_R:   Math.PI - 0.44,   // right flipper rest angle
  ACT_R:    Math.PI + 0.44,   // right flipper active angle
};
// Drain y — ball drains if it passes below this (below REST tips at y≈782)
const DRAIN_Y = 815;
// Inlane guide walls
const inlaneL=108, inlaneR=372;

// ─── STATE ────────────────────────────────────────────────────────────────────
let _ov=null,_canvas=null,_dmd=null,_ctx=null,_dctx=null,_animId=null,_ac=null;
let _state=null,_data=null,_api=null,_table=null,_tdef=null;
const _keys={left:false,right:false,space:false};
let _pb={};

function freshPB(id){
  return {
    tableId:id,
    ball:{x:PB.W-28,y:PB.H-150,vx:0,vy:0,z:0,vz:0,active:false,lost:false},
    extras:[],
    flippers:[], bumpers:[], targets:[], slings:[], ramps:[],
    lights:[], wormHoles:[], dropBanks:[], locks:[], kickers:[],
    score:0, ballsLeft:3, ballNum:1, multiplier:1,
    combo:0, comboTimer:0,
    plungerCharge:0, launched:false,
    phase:'attract', phaseTimer:0,
    modeActive:null, modeTimer:0, modeData:{},
    dmdMsg:'', dmdFlash:0, dmdSub:'',
    tableProgress:{},
    highScores:[],
    lastMatch:null,
    pulses:[],       // visual hit pulses
    strobes:[],      // strobe light effects
    arrows:[],       // lit directional arrows on table
  };
}

// ─── ENTRY ────────────────────────────────────────────────────────────────────
export function openPinball(tableId,state,data,api){
  _state=state||null; _data=data||null; _api=api||null;
  const tables=(_data?.pinball?.tables)||defaultTables();
  _tdef=tables.find(t=>t.id===tableId)||tables[0];
  injectStyles();
  if(_ov){_ov.remove();cancelAnimationFrame(_animId);cleanup();}
  _ov=document.createElement('div');
  _ov.id='pbOv'; _ov.className='pb-ov';
  document.body.appendChild(_ov);
  buildUI();
  _pb=freshPB(tableId);
  _table=buildTable(tableId);
  applyTableToPB();
  _pb.highScores=JSON.parse(localStorage.getItem('pb_hi_'+tableId)||'[]');
  initAudio(); bindKeys();
  _pb.phase='attract';
  loop();
}

function defaultTables(){
  return [
    {id:'worm_holer',   name:'WORM HOLER',    subtitle:'Survive the Singularity', ballColor:'#c0e0ff',accentColor:'#4400ff',secondColor:'#ff00cc',bgColor:'#000008'},
    {id:'barfs_house',  name:"BARF'S HOUSE",  subtitle:'Based on the Hit TV Show!',ballColor:'#ffdd44',accentColor:'#ff6600',secondColor:'#00cc44',bgColor:'#1a0800'},
    {id:'shower_defense',name:'SHOWER DEFENSE',subtitle:'Defend Your Drain!',      ballColor:'#aaddff',accentColor:'#0088ff',secondColor:'#00ffcc',bgColor:'#001820'},
  ];
}

function applyTableToPB(){
  _pb.flippers  =_table.flippers;
  _pb.bumpers   =_table.bumpers;
  _pb.targets   =_table.targets;
  _pb.slings    =_table.slings;
  _pb.ramps     =_table.ramps;
  _pb.lights    =_table.lights;
  _pb.wormHoles =_table.wormHoles||[];
  _pb.dropBanks =_table.dropBanks||[];
  _pb.locks     =_table.locks||[];
  _pb.kickers   =_table.kickers||[];
  _pb.arrows    =_table.arrows||[];
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function buildUI(){
  _ov.innerHTML=`
  <div class="pb-shell">
    <div class="pb-dmd-bar">
      <canvas id="pbDMD" width="480" height="96"></canvas>
    </div>
    <div class="pb-field">
      <canvas id="pbCanvas" width="${PB.W}" height="${PB.H}"></canvas>
    </div>
    <div class="pb-btns">
      <button class="pb-btn pb-l"
        onmousedown="pbK('left',1)" onmouseup="pbK('left',0)"
        ontouchstart="pbK('left',1);event.preventDefault()" ontouchend="pbK('left',0)">◀ LEFT</button>
      <button class="pb-btn pb-m"
        onmousedown="pbK('space',1)" onmouseup="pbK('space',0)"
        ontouchstart="pbK('space',1);event.preventDefault()" ontouchend="pbK('space',0)">LAUNCH</button>
      <button class="pb-btn pb-r"
        onmousedown="pbK('right',1)" onmouseup="pbK('right',0)"
        ontouchstart="pbK('right',1);event.preventDefault()" ontouchend="pbK('right',0)">RIGHT ▶</button>
    </div>
  </div>
  <button class="pb-x" onclick="pbClose()">✕</button>`;
  _canvas=document.getElementById('pbCanvas');
  _ctx=_canvas.getContext('2d');
  _dmd=document.getElementById('pbDMD');
  _dctx=_dmd.getContext('2d');
  window.pbK=(k,v)=>{_keys[k]=!!v;};
  window.pbClose=pbClose;
}

function bindKeys(){
  const kd=e=>{
    if(e.key==='ArrowLeft'){_keys.left=true;e.preventDefault();}
    if(e.key==='ArrowRight'){_keys.right=true;e.preventDefault();}
    if(e.key===' '){_keys.space=true;e.preventDefault();}
    if(e.key==='Escape') pbClose();
  };
  const ku=e=>{
    if(e.key==='ArrowLeft')_keys.left=false;
    if(e.key==='ArrowRight')_keys.right=false;
    if(e.key===' ')_keys.space=false;
  };
  window.addEventListener('keydown',kd);
  window.addEventListener('keyup',ku);
  _ov._kd=kd; _ov._ku=ku;
}

function cleanup(){
  if(_ov?._kd){window.removeEventListener('keydown',_ov._kd);window.removeEventListener('keyup',_ov._ku);}
  if(_ac){try{_ac.close();}catch(e){}_ac=null;}
}
function pbClose(){cancelAnimationFrame(_animId);cleanup();_ov?.remove();_ov=null;}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
let _lastTs=0;
function loop(ts=0){
  _animId=requestAnimationFrame(loop);
  const dt=Math.min((ts-_lastTs)/16.67,3);
  _lastTs=ts;
  update(dt);
  draw();
  drawDMD();
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────
function update(dt){
  _pb.phaseTimer+=dt;
  if(_pb.dmdFlash>0)_pb.dmdFlash-=dt;
  _pb.pulses=_pb.pulses.filter(p=>{p.life-=dt;return p.life>0;});
  _pb.strobes=_pb.strobes.filter(s=>{s.life-=dt;return s.life>0;});
  _pb.lights.forEach(l=>{l.phase+=l.speed*dt;});
  if(_pb.combo>0){_pb.comboTimer-=dt;if(_pb.comboTimer<=0)_pb.combo=0;}
  if(_pb.modeActive&&_pb.modeTimer>0){_pb.modeTimer-=dt;if(_pb.modeTimer<=0)endMode();}

  switch(_pb.phase){
    case 'attract': if(_pb.phaseTimer>4||anyKey()) startBall(); break;
    case 'plunge':  updatePlunge(dt); break;
    case 'play':    updatePlay(dt); break;
    case 'lost':    if(_pb.phaseTimer>2.2){_pb.ballsLeft<=0?endGame():startBall();} break;
    case 'gameover':if(_pb.phaseTimer>2.8){saveScore();_pb.phase='scores';_pb.phaseTimer=0;} break;
    case 'scores':  if(anyKey()&&_pb.phaseTimer>1) restartGame(); break;
  }
}

function anyKey(){return _keys.left||_keys.right||_keys.space;}

function updatePlunge(dt){
  updateFlippers(dt);
  if(_keys.space){
    _pb.plungerCharge=Math.min(_pb.plungerCharge+0.55*dt,PB.PLUNGER_MAX);
  } else if(_pb.plungerCharge>0){
    launchBall();
    return;
  }
  // Keep ball sitting on plunger head — moves UP as charge increases
  const laneBot=PB.H-90, laneTop=90, laneH=laneBot-laneTop;
  const charge=_pb.plungerCharge/PB.PLUNGER_MAX;
  const springH=charge*laneH*0.62;
  const springY=laneBot-springH;
  _pb.ball.x=PB.W-26;
  _pb.ball.y=springY-9-PB.BALL_R; // ball center above plunger head
  _pb.ball.vx=0; _pb.ball.vy=0;
}

function updatePlay(dt){
  updateFlippers(dt);
  updateBall(_pb.ball,dt);
  _pb.extras.forEach(b=>updateBall(b,dt));
  _pb.extras=_pb.extras.filter(b=>!b.lost);
  if(_pb.ball.lost&&_pb.extras.length===0){
    _pb.ballsLeft--;
    _pb.phase='lost'; _pb.phaseTimer=0;
    dmd('BALL LOST!','');
    snd('drain');
  }
  _table.logic&&_table.logic(dt);
}

// ─── BALL PHYSICS ─────────────────────────────────────────────────────────────
function flipAngle(f){
  if(f.side==='left')  return f.active ? FL.ACT_L : FL.REST_L;
  else                 return f.active ? FL.ACT_R : FL.REST_R;
}

function flipTip(f){
  const a = flipAngle(f);
  return { x: f.x + FL.len*Math.cos(a), y: f.y + FL.len*Math.sin(a) };
}

function updateBall(b,dt){
  if(!b.active||b.lost)return;

  // ── Gravity ──────────────────────────────────────────────────────────────
  b.vy += 0.30 * dt;

  // ── Move ─────────────────────────────────────────────────────────────────
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // ── Speed cap ────────────────────────────────────────────────────────────
  const spd = Math.hypot(b.vx, b.vy);
  if(spd > 28){ const s=28/spd; b.vx*=s; b.vy*=s; }
  b.vx *= 0.9994; b.vy *= 0.9994; // very light friction

  // ── Wall collisions ───────────────────────────────────────────────────────
  const r = PB.BALL_R;
  if(b.x - r < wallL){ b.x = wallL+r; b.vx = Math.abs(b.vx)*0.60; snd('wall'); }
  if(b.x + r > wallR){ b.x = wallR-r; b.vx = -Math.abs(b.vx)*0.60; snd('wall'); }
  if(b.y - r < wallT){ b.y = wallT+r; b.vy = Math.abs(b.vy)*0.60; snd('wall'); }

  // ── Plunger lane right wall ───────────────────────────────────────────────
  // Ball in plunger lane (x > wallR-8) bounces off PB.W-8
  if(b.x > wallR-8){
    if(b.x + r > PB.W-8){ b.x=PB.W-8-r; b.vx=-Math.abs(b.vx)*0.55; }
    // Exit arc at top: when ball rises above y=120, kick left onto playfield
    if(b.y < 120 && b.vy < 0){
      b.vx = -Math.abs(b.vx)*0.6 - 5;
      b.vy *= 0.5;
      b.x = wallR - 20;
    }
    // Ball falls back — reset to plunge
    if(b.vy > 0 && b.y > PB.H - 180 && _pb.phase === 'play'){
      b.x=PB.W-26; b.y=PB.H-110; b.vx=0; b.vy=0;
      _pb.phase='plunge'; _pb.plungerCharge=0;
      dmd('PULL AND RELEASE','TRY AGAIN!');
    }
    return; // don't apply other physics while in plunger lane
  }

  // ── Bumpers ───────────────────────────────────────────────────────────────
  _pb.bumpers.forEach(bmp => {
    if(bmp.cooldown > 0){ bmp.cooldown -= dt; return; }
    const dx=b.x-bmp.x, dy=b.y-bmp.y, d=Math.hypot(dx,dy);
    if(d < bmp.r + r){
      const nx=dx/d||0, ny=dy/d||1;
      // Push ball cleanly outside
      b.x = bmp.x + nx*(bmp.r+r+2);
      b.y = bmp.y + ny*(bmp.r+r+2);
      // Exit velocity: away from bumper, minimum speed
      const exitSpd = Math.max(8, spd*0.7+5);
      b.vx = nx*exitSpd; b.vy = ny*exitSpd;
      bmp.cooldown = 0.15;
      bmp.hits++; bmp.flashTimer = 0.4;
      addPts(bmp.pts*_pb.multiplier, bmp.x, bmp.y);
      _pb.combo++; _pb.comboTimer = 3;
      _pb.pulses.push({x:bmp.x,y:bmp.y,r:bmp.r,life:0.45,max:0.45,color:bmp.ring,type:'ring'});
      _pb.pulses.push({x:bmp.x,y:bmp.y,r:bmp.r*0.4,life:0.2,max:0.2,color:'#fff',type:'fill'});
      _pb.strobes.push({x:bmp.x,y:bmp.y,r:bmp.r*3.5,life:0.3,max:0.3,color:bmp.ring});
      snd('bumper');
      _table.onBumper && _table.onBumper(bmp);
    }
    if(bmp.flashTimer > 0) bmp.flashTimer -= dt;
  });

  // ── Slingshots ────────────────────────────────────────────────────────────
  _pb.slings.forEach(s => {
    if(b.x+r>s.x && b.x-r<s.x+s.w && b.y+r>s.y && b.y-r<s.y+s.h){
      b.vx = s.kickVx + (Math.random()-0.5)*1.5;
      b.vy = s.kickVy - Math.random()*1.5;
      addPts(s.pts*_pb.multiplier, s.x+s.w/2, s.y+s.h/2);
      _pb.pulses.push({x:s.x+s.w/2,y:s.y+s.h/2,r:22,life:0.22,max:0.22,color:s.color,type:'ring'});
      snd('bumper');
    }
  });

  // ── Drop targets — SOLID even when hit ───────────────────────────────────
  // Targets remain as physical walls regardless of hit state
  // Hitting them just changes their visual color
  const allTargets = [
    ..._pb.targets,
    ..._pb.dropBanks.flatMap(bk=>bk.targets)
  ];
  allTargets.forEach(t => {
    const inX = b.x+r > t.x && b.x-r < t.x+t.w;
    const inY = b.y+r > t.y && b.y-r < t.y+t.h;
    if(inX && inY){
      // Determine which face ball hit (find shortest overlap axis)
      const overlapL = (b.x+r) - t.x;
      const overlapR = (t.x+t.w) - (b.x-r);
      const overlapT = (b.y+r) - t.y;
      const overlapB = (t.y+t.h) - (b.y-r);
      const minH = Math.min(overlapL, overlapR);
      const minV = Math.min(overlapT, overlapB);
      if(minH < minV){
        // Horizontal collision
        if(overlapL < overlapR){ b.x=t.x-r; b.vx=-Math.abs(b.vx)*0.55; }
        else                    { b.x=t.x+t.w+r; b.vx=Math.abs(b.vx)*0.55; }
      } else {
        // Vertical collision
        if(overlapT < overlapB){ b.y=t.y-r; b.vy=-Math.abs(b.vy)*0.55; }
        else                    { b.y=t.y+t.h+r; b.vy=Math.abs(b.vy)*0.55; }
      }
      // Score only on first hit
      if(!t.hit){
        t.hit=true; t.flashTimer=0.5;
        addPts(t.pts*_pb.multiplier, t.x+t.w/2, t.y+t.h/2);
        _pb.pulses.push({x:t.x+t.w/2,y:t.y+t.h/2,r:18,life:0.32,max:0.32,color:t.color,type:'ring'});
        snd('target');
        checkGroup(t.group);
      }
    }
    if(t.flashTimer>0) t.flashTimer-=dt;
  });

  // ── Kicker holes ─────────────────────────────────────────────────────────
  _pb.kickers.forEach(k => {
    if(Math.hypot(b.x-k.x, b.y-k.y) < k.r+r){
      b.vx=k.vx; b.vy=k.vy;
      addPts(k.pts*_pb.multiplier, k.x, k.y);
      _pb.pulses.push({x:k.x,y:k.y,r:k.r*2,life:0.4,max:0.4,color:k.color,type:'ring'});
      snd('bumper');
    }
  });

  // ── Flipper collision ─────────────────────────────────────────────────────
  _pb.flippers.forEach(f => {
    const a  = flipAngle(f);
    const px = f.x, py = f.y;
    const tx = px + FL.len*Math.cos(a), ty = py + FL.len*Math.sin(a);
    // Project ball onto flipper line segment
    const dx=tx-px, dy=ty-py, lenSq=dx*dx+dy*dy;
    let t2 = ((b.x-px)*dx+(b.y-py)*dy)/lenSq;
    t2 = Math.max(0, Math.min(1, t2));
    const cx=px+t2*dx, cy=py+t2*dy;
    const ex=b.x-cx, ey=b.y-cy, ed=Math.hypot(ex,ey);
    const thick = FL.w/2 + r;
    if(ed < thick && ed > 0){
      const nx=ex/ed, ny=ey/ed;
      // Push ball outside flipper surface
      b.x = cx + nx*(thick+1);
      b.y = cy + ny*(thick+1);
      // Reflect velocity
      const dot = b.vx*nx + b.vy*ny;
      b.vx -= 2*dot*nx*0.65;
      b.vy -= 2*dot*ny*0.65;
      if(f.active){
        // Add launch velocity component upward along flipper normal
        const boost = f.side==='left' ? 1 : -1;
        b.vy += ny < 0 ? -14 : -8;   // strong upward kick
        b.vx += boost * 5;
        snd('flipper');
      }
    }
  });

  // ── Lock holes ────────────────────────────────────────────────────────────
  checkLocks(b);

  // ── Ramp entry ───────────────────────────────────────────────────────────
  checkRampEntry(b);

  // ── Worm holes ────────────────────────────────────────────────────────────
  checkWormHoles(b);

  // ── Drain check ──────────────────────────────────────────────────────────
  // Ball drains if it passes below DRAIN_Y (below flipper REST tips)
  // OR if it falls into left/right gutters past the flipper pivots
  const tip = flipTip(_pb.flippers[0]); // left flipper rest tip
  const centerGapL = tip.x;
  const centerGapR = PB.W - tip.x; // symmetric
  const pastFlippers = b.y > FL.y + 50; // clearly below pivot
  const inGutter = (b.x < inlaneL && b.y > FL.y - 20) ||
                   (b.x > inlaneR && b.y > FL.y - 20);
  const inCenterDrain = b.x > centerGapL - 5 && b.x < centerGapR + 5 && b.y > DRAIN_Y;
  if(inCenterDrain || inGutter){ b.lost=true; }
}


function checkRampEntry(b){
  if(b.z>0)return;
  _pb.ramps.forEach(r=>{
    const ep=r.path[0];
    if(Math.hypot(b.x-ep.x,b.y-ep.y)<22&&Math.hypot(b.vx,b.vy)>4.5){
      b.z=1; b.vz=0.4;
      addPts(500*_pb.multiplier,ep.x,ep.y);
      snd('ramp');
      const np=r.path[1];
      const ang=Math.atan2(np.y-ep.y,np.x-ep.x);
      const spd=Math.hypot(b.vx,b.vy)*1.15;
      b.vx=Math.cos(ang)*spd; b.vy=Math.sin(ang)*spd;
      r.lit=true; r.litTimer=2;
      // Arrow lights along ramp
      r.path.forEach((_,i)=>{
        setTimeout(()=>{
          _pb.pulses.push({x:r.path[i].x,y:r.path[i].y,r:6,life:0.4,max:0.4,color:r.color,type:'ring'});
        },i*120);
      });
      setTimeout(()=>{
        if(b.active&&!b.lost){
          b.x=r.exitX;b.y=r.exitY;
          b.vx=r.exitVx*5;b.vy=r.exitVy*5;
          b.z=0;b.vz=0;
          addPts(1500*_pb.multiplier,r.exitX,r.exitY);
        }
      },r.travelMs||900);
    }
  });
  _pb.ramps.forEach(r=>{if(r.litTimer>0){r.litTimer-=0.016;if(r.litTimer<=0)r.lit=false;}});
}

// ─── WORM HOLES ───────────────────────────────────────────────────────────────
function checkWormHoles(b){
  _pb.wormHoles.filter(w=>w.active).forEach(w=>{
    if(Math.hypot(b.x-w.x,b.y-w.y)<w.r+PB.BALL_R){
      const exits=_pb.wormHoles.filter(e=>e.active&&e!==w);
      if(exits.length){
        const dest=exits[Math.floor(Math.random()*exits.length)];
        b.x=dest.x;b.y=dest.y;
        b.vx=(Math.random()-0.5)*8;b.vy=-4-Math.random()*4;
        addPts(5000*_pb.multiplier,dest.x,dest.y);
        _pb.strobes.push({x:dest.x,y:dest.y,r:80,life:0.6,max:0.6,color:w.color});
        snd('wormHole');
        dmd('QUANTUM LEAP!','');
      }
    }
  });
}

// ─── LOCKS & MULTIBALL ────────────────────────────────────────────────────────
function checkLocks(b){
  _pb.locks.forEach(lk=>{
    if(lk.locked)return;
    if(Math.hypot(b.x-lk.x,b.y-lk.y)<lk.r+PB.BALL_R){
      lk.locked=true;
      b.active=false;
      addPts(3000*_pb.multiplier,lk.x,lk.y);
      dmd('BALL LOCKED!','SHOOT TO RELEASE');
      snd('groupComplete');
      // Launch multiball after 1.5s
      setTimeout(()=>{
        lk.locked=false;
        b.active=true; b.x=lk.x;b.y=lk.y;
        b.vx=(Math.random()-0.5)*6;b.vy=-8;
        startMultiball(1);
      },1500);
    }
  });
}

function startMultiball(extra){
  if(_pb.extras.length>=3)return;
  snd('multiball');
  dmd('MULTIBALL!','');
  for(let i=0;i<extra;i++){
    _pb.extras.push({
      x:PB.W/2+(Math.random()-0.5)*80,y:350,
      vx:(Math.random()-0.5)*10,vy:-6-Math.random()*5,
      z:0,vz:0,active:true,lost:false
    });
  }
  _pb.multiplier=Math.min(_pb.multiplier+1,6);
}

// ─── TARGET GROUPS ────────────────────────────────────────────────────────────
function checkGroup(group){
  if(!group)return;
  const g=_pb.targets.filter(t=>t.group===group);
  const bankG=_pb.dropBanks.flatMap(b=>b.targets).filter(t=>t.group===group);
  const all=[...g,...bankG];
  if(all.length&&all.every(t=>t.hit)){
    groupComplete(group);
    setTimeout(()=>all.forEach(t=>t.hit=false),1200);
  }
}

function groupComplete(group){
  addPts(3000*_pb.multiplier,PB.W/2,PB.H/2);
  snd('groupComplete');
  _pb.strobes.push({x:PB.W/2,y:PB.H/2,r:300,life:0.5,max:0.5,color:_tdef?.accentColor||'#fff'});
  _table.onGroup&&_table.onGroup(group);
}

// ─── MODES ────────────────────────────────────────────────────────────────────
function triggerMode(name,dur,sub){
  _pb.modeActive=name; _pb.modeTimer=dur;
  snd('modeStart');
  dmd(name.toUpperCase().replace(/([A-Z])/g,' $1').trim()+'!',sub||'');
}
function endMode(){
  addPts(8000*_pb.multiplier,PB.W/2,400);
  dmd('MODE COMPLETE!','');
  snd('modeEnd');
  _pb.modeActive=null;
}
function dmd(msg,sub){_pb.dmdMsg=msg;_pb.dmdSub=sub||'';_pb.dmdFlash=2.5;}

// ─── BALL START / END ─────────────────────────────────────────────────────────
function startBall(){
  // Ball rests at BOTTOM of plunger lane, sitting on the plunger head
  // laneBot=PB.H-90=730, plunger head r=9, ball r=11 => ball center at 730-20=710
  _pb.ball={x:PB.W-26,y:PB.H-110,vx:0,vy:0,z:0,vz:0,active:true,lost:false};
  _pb.extras=[]; _pb.plungerCharge=0; _pb.launched=false;
  _pb.targets.forEach(t=>t.hit=false);
  _pb.dropBanks.forEach(bk=>bk.targets.forEach(t=>t.hit=false));
  _pb.bumpers.forEach(b=>{b.cooldown=0;b.flashTimer=0;});
  _pb.ballNum=4-_pb.ballsLeft;
  _pb.phase='plunge'; _pb.phaseTimer=0;
  dmd('PULL AND RELEASE','GOOD LUCK!');
}

function launchBall(){
  // Ball is currently sitting on the plunger head somewhere in the lane.
  // Release: give it full upward velocity from current position.
  // Minimum velocity ensures ball always makes it to the exit arc.
  const minVy=18; // enough to reach top from rest position
  _pb.ball.vy=-Math.max(_pb.plungerCharge*1.15, minVy);
  _pb.ball.vx=-0.3; // slight left nudge so ball curves toward playfield exit
  _pb.plungerCharge=0; _pb.launched=true;
  _pb.phase='play';
  snd('launch');
}

function endGame(){
  _pb.phase='gameover'; _pb.phaseTimer=0;
  dmd('GAME OVER','');
  snd('gameOver');
}

function saveScore(){
  const e={score:_pb.score,date:new Date().toLocaleDateString()};
  _pb.highScores.push(e);
  _pb.highScores.sort((a,b)=>b.score-a.score);
  _pb.highScores=_pb.highScores.slice(0,8);
  localStorage.setItem('pb_hi_'+_table.id,JSON.stringify(_pb.highScores));
  const match=Math.floor(Math.random()*10);
  _pb.lastMatch={match,won:(_pb.score%10)===match};
}

function restartGame(){
  const id=_table.id;
  const hi=_pb.highScores;
  _pb=freshPB(id);
  _table=buildTable(id);
  applyTableToPB();
  _pb.highScores=hi;
  _pb.phase='attract'; _pb.phaseTimer=0;
}

function addPts(pts,x,y){
  _pb.score+=Math.floor(pts);
  _pb.pulses.push({x,y,r:0,life:0.9,max:0.9,pts:Math.floor(pts),type:'score'});
}

// ─── TABLE DEFINITIONS ────────────────────────────────────────────────────────
function buildTable(id){
  switch(id){
    case 'worm_holer':    return tableWormHoler();
    case 'barfs_house':   return tableBarfsHouse();
    case 'shower_defense':return tableShowerDefense();
    default:              return tableWormHoler();
  }
}

// Standard flipper pair (all tables share this base)
function stdFlippers(extraFlippers=[]){
  return [
    {x:FL.leftX,  y:FL.y, len:FL.len, w:FL.w, side:'left',  active:false},
    {x:FL.rightX, y:FL.y, len:FL.len, w:FL.w, side:'right', active:false},
    ...extraFlippers
  ];
}

// ════════════════════════════════════════════════════════
// WORM HOLER
// ════════════════════════════════════════════════════════
function tableWormHoler(){
  // Mid-table flippers (smaller, same buttons)
  const flippers=stdFlippers([
    {x:110,y:530,angle:-0.42,len:55,w:9,side:'left', active:false,z:0},
    {x:370,y:530,angle:Math.PI+0.42,len:55,w:9,side:'right',active:false,z:0},
  ]);

  // Bumpers spread min 85px center-to-center to prevent ping-pong traps
  const bumpers=[
    {x:168,y:210,r:24,label:'SOL',   pts:100,color:'#2244ff',ring:'#6699ff',hits:0,flashTimer:0,cooldown:0},
    {x:312,y:190,r:24,label:'VEGA',  pts:150,color:'#8822ff',ring:'#cc66ff',hits:0,flashTimer:0,cooldown:0},
    {x:240,y:265,r:22,label:'CORE',  pts:200,color:'#ff2244',ring:'#ff7799',hits:0,flashTimer:0,cooldown:0},
    {x:152,y:335,r:20,label:'NOVA',  pts:120,color:'#2266ff',ring:'#55aaff',hits:0,flashTimer:0,cooldown:0},
    {x:328,y:325,r:20,label:'CYGNUS',pts:120,color:'#9922ff',ring:'#dd66ff',hits:0,flashTimer:0,cooldown:0},
    {x:178,y:142,r:18,label:'DEEP',  pts:300,color:'#ff4400',ring:'#ff9966',hits:0,flashTimer:0,cooldown:0},
    {x:302,y:130,r:18,label:'VOID',  pts:300,color:'#4400ff',ring:'#8855ff',hits:0,flashTimer:0,cooldown:0},
  ];

  // Slingshots (triangular kickers on sides, classic pinball feature)
  const slings=[
    {x:60, y:600,w:22,h:80,kickVx:7, kickVy:-5,color:'#4488ff',pts:50},  // left
    {x:398,y:600,w:22,h:80,kickVx:-7,kickVy:-5,color:'#4488ff',pts:50},  // right
  ];

  // Drop target banks
  const dropBanks=[
    {label:'WORM',targets:[
      {x:68,y:420,w:16,h:32,label:'W',pts:400,color:'#4488ff',hit:false,flashTimer:0,group:'worm'},
      {x:68,y:456,w:16,h:32,label:'O',pts:400,color:'#4488ff',hit:false,flashTimer:0,group:'worm'},
      {x:68,y:492,w:16,h:32,label:'R',pts:400,color:'#4488ff',hit:false,flashTimer:0,group:'worm'},
      {x:68,y:528,w:16,h:32,label:'M',pts:400,color:'#4488ff',hit:false,flashTimer:0,group:'worm'},
    ]},
    {label:'HOLE',targets:[
      {x:396,y:420,w:16,h:32,label:'H',pts:400,color:'#ff44cc',hit:false,flashTimer:0,group:'hole'},
      {x:396,y:456,w:16,h:32,label:'O',pts:400,color:'#ff44cc',hit:false,flashTimer:0,group:'hole'},
      {x:396,y:492,w:16,h:32,label:'L',pts:400,color:'#ff44cc',hit:false,flashTimer:0,group:'hole'},
      {x:396,y:528,w:16,h:32,label:'E',pts:400,color:'#ff44cc',hit:false,flashTimer:0,group:'hole'},
    ]},
  ];

  const targets=[
    // Orbit completion targets at ramp exits
    {x:80, y:95, w:20,h:14,label:'◀',pts:800,color:'#44ffff',hit:false,flashTimer:0,group:'orbit_l'},
    {x:380,y:95, w:20,h:14,label:'▶',pts:800,color:'#44ffff',hit:false,flashTimer:0,group:'orbit_r'},
    // Multiplier standup targets
    {x:195,y:445,w:16,h:28,label:'2×',pts:1000,color:'#ffaa00',hit:false,flashTimer:0,group:'multi'},
    {x:218,y:445,w:16,h:28,label:'3×',pts:1000,color:'#ffaa00',hit:false,flashTimer:0,group:'multi'},
    {x:241,y:445,w:16,h:28,label:'5×',pts:1000,color:'#ffaa00',hit:false,flashTimer:0,group:'multi'},
  ];

  const ramps=[
    {type:'orbit',side:'left',
     path:[{x:82,y:660},{x:52,y:480},{x:52,y:280},{x:115,y:155},{x:195,y:115}],
     exitX:195,exitY:115,exitVx:2.5,exitVy:0.5,z:1,color:'#2244aa',lit:false,litTimer:0,travelMs:850},
    {type:'orbit',side:'right',
     path:[{x:398,y:660},{x:428,y:480},{x:428,y:280},{x:365,y:155},{x:285,y:115}],
     exitX:285,exitY:115,exitVx:-2.5,exitVy:0.5,z:1,color:'#6622aa',lit:false,litTimer:0,travelMs:850},
    {type:'loop',
     path:[{x:200,y:380},{x:200,y:280},{x:280,y:280},{x:280,y:380}],
     exitX:280,exitY:385,exitVx:1.5,exitVy:2,z:1,color:'#884400',lit:false,litTimer:0,travelMs:700},
  ];

  const wormHoles=[
    {x:240,y:710,r:24,active:false,color:'#4400ff',label:'ENTRANCE',hits:0},
    {x:130,y:255,r:20,active:false,color:'#8800ff',label:'EXIT A',  hits:0},
    {x:350,y:255,r:20,active:false,color:'#cc00ff',label:'EXIT B',  hits:0},
    {x:240,y:155,r:18,active:false,color:'#ff00cc',label:'SINGULARITY',hits:0},
  ];

  const locks=[
    {x:240,y:570,r:18,locked:false,color:'#00ccff',label:'LOCK'},
  ];

  const kickers=[
    {x:240,y:95,r:16,vx:0,vy:-10,pts:500,color:'#00ffff',label:'SHOOTER'},
  ];

  const lights=buildStarLights();

  const arrows=[
    {x:100,y:640,angle:-0.4,color:'#4488ff',lit:false,label:'ORBIT'},
    {x:380,y:640,angle:Math.PI+0.4,color:'#4488ff',lit:false,label:'ORBIT'},
    {x:195,y:410,angle:-Math.PI/2,color:'#ffaa00',lit:false,label:'MULTI'},
    {x:240,y:680,angle:-Math.PI/2,color:'#8800ff',lit:false,label:'WORM'},
  ];

  return {
    id:'worm_holer',
    flippers,bumpers,slings,targets,dropBanks,ramps,wormHoles,locks,kickers,lights,arrows,
    wallColor:'#06061a',railColor:'#0022aa',fieldColor:'#00000c',
    inlaneColor:'#001166',slingsColor:'#0033cc',
    drawBg: drawWHBg,
    logic: whLogic,
    onBumper: whOnBumper,
    onGroup: whOnGroup,
  };
}

function buildStarLights(){
  const l=[];
  for(let i=0;i<35;i++){
    l.push({x:60+Math.random()*360,y:80+Math.random()*700,
      r:1+Math.random()*2.5,color:['#fff','#aaccff','#ffaacc','#ccaaff'][i%4],
      phase:Math.random()*Math.PI*2,speed:0.015+Math.random()*0.04,type:'star'});
  }
  // Inlane indicator lights
  [680,710,740].forEach((y,i)=>{
    l.push({x:82,y,r:6,color:'#4488ff',phase:i*0.8,speed:0.04,type:'inlane'});
    l.push({x:398,y,r:6,color:'#4488ff',phase:i*0.8,speed:0.04,type:'inlane'});
  });
  return l;
}

function whLogic(dt){
  // Gravity wells toward active worm holes
  _pb.wormHoles.filter(w=>w.active).forEach(w=>{
    [_pb.ball,..._pb.extras].forEach(b=>{
      if(!b.active||b.lost)return;
      const dx=w.x-b.x,dy=w.y-b.y,d=Math.hypot(dx,dy);
      if(d<130&&d>w.r+PB.BALL_R+5){
        b.vx+=dx/d*0.10*dt; b.vy+=dy/d*0.10*dt;
      }
    });
  });
}

function whOnBumper(b){
  _pb.tableProgress.bumps=(_pb.tableProgress.bumps||0)+1;
  if(_pb.tableProgress.bumps%15===0) startMultiball(1);
}

function whOnGroup(group){
  if(group==='worm'||group==='hole'){
    const wh=_pb.wormHoles.find(w=>!w.active);
    if(wh){wh.active=true;snd('wormHoleActivate');dmd('WORM HOLE OPEN!','');}
  }
  if(group==='multi'){
    _pb.multiplier=Math.min(_pb.multiplier+1,5);
    dmd('MULTIPLIER '+_pb.multiplier+'×!','');
  }
  if(group==='orbit_l'||group==='orbit_r') triggerMode('orbitMadness',20,'SHOOT ORBITS!');
}

// ════════════════════════════════════════════════════════
// BARF'S HOUSE
// ════════════════════════════════════════════════════════
function tableBarfsHouse(){
  const flippers=stdFlippers([
    // Upper kitchen flipper (left only)
    {x:120,y:400,angle:-0.38,len:58,w:9,side:'left',active:false,z:0},
  ]);

  const bumpers=[
    {x:162,y:195,r:26,label:"BARF!",   pts:100,color:'#cc4400',ring:'#ff8844',hits:0,flashTimer:0,cooldown:0},
    {x:295,y:172,r:26,label:'SQUAWK!', pts:150,color:'#336600',ring:'#66dd00',hits:0,flashTimer:0,cooldown:0},
    {x:375,y:225,r:22,label:'CUSTOMER',pts:100,color:'#cc3300',ring:'#ff7744',hits:0,flashTimer:0,cooldown:0},
    {x:200,y:272,r:20,label:'TABLE 3', pts:200,color:'#774400',ring:'#cc8844',hits:0,flashTimer:0,cooldown:0},
    {x:328,y:305,r:20,label:'GRILL IT',pts:200,color:'#aa2200',ring:'#ff6644',hits:0,flashTimer:0,cooldown:0},
    {x:142,y:338,r:20,label:'HEALTH!', pts:300,color:'#dd0044',ring:'#ff5588',hits:0,flashTimer:0,cooldown:0},
    {x:252,y:148,r:18,label:'SPECIALS!',pts:250,color:'#886600',ring:'#ffcc44',hits:0,flashTimer:0,cooldown:0},
  ];

  const slings=[
    {x:58, y:580,w:24,h:90,kickVx:8, kickVy:-4,color:'#ff6600',pts:50},
    {x:398,y:580,w:24,h:90,kickVx:-8,kickVy:-4,color:'#44aa00',pts:50},
  ];

  const dropBanks=[
    {label:'SERVE',targets:[
      {x:66,y:415,w:16,h:32,label:'S',pts:300,color:'#ff8800',hit:false,flashTimer:0,group:'serve'},
      {x:66,y:451,w:16,h:32,label:'E',pts:300,color:'#ff8800',hit:false,flashTimer:0,group:'serve'},
      {x:66,y:487,w:16,h:32,label:'R',pts:300,color:'#ff8800',hit:false,flashTimer:0,group:'serve'},
      {x:66,y:523,w:16,h:32,label:'V',pts:300,color:'#ff8800',hit:false,flashTimer:0,group:'serve'},
      {x:66,y:559,w:16,h:32,label:'E',pts:300,color:'#ff8800',hit:false,flashTimer:0,group:'serve'},
    ]},
    {label:'CHIKN',targets:[
      {x:398,y:415,w:16,h:32,label:'C',pts:400,color:'#44cc00',hit:false,flashTimer:0,group:'chicken'},
      {x:398,y:451,w:16,h:32,label:'H',pts:400,color:'#44cc00',hit:false,flashTimer:0,group:'chicken'},
      {x:398,y:487,w:16,h:32,label:'I',pts:400,color:'#44cc00',hit:false,flashTimer:0,group:'chicken'},
      {x:398,y:523,w:16,h:32,label:'C',pts:400,color:'#44cc00',hit:false,flashTimer:0,group:'chicken'},
      {x:398,y:559,w:16,h:32,label:'K',pts:400,color:'#44cc00',hit:false,flashTimer:0,group:'chicken'},
    ]},
  ];

  const targets=[
    {x:170,y:430,w:16,h:30,label:'⭐',pts:1000,color:'#ffdd00',hit:false,flashTimer:0,group:'stars'},
    {x:192,y:430,w:16,h:30,label:'⭐',pts:1000,color:'#ffdd00',hit:false,flashTimer:0,group:'stars'},
    {x:214,y:430,w:16,h:30,label:'⭐',pts:1000,color:'#ffdd00',hit:false,flashTimer:0,group:'stars'},
    // Kitchen standup targets
    {x:155,y:330,w:14,h:24,label:'KIT',pts:600,color:'#ffaa00',hit:false,flashTimer:0,group:'kitchen'},
    {x:305,y:335,w:14,h:24,label:'CHN',pts:600,color:'#ffaa00',hit:false,flashTimer:0,group:'kitchen'},
    {x:230,y:95, w:20,h:14,label:'🍗', pts:2000,color:'#ffcc00',hit:false,flashTimer:0,group:'jackpot'},
  ];

  const ramps=[
    {type:'orbit',side:'left',
     path:[{x:82,y:650},{x:54,y:470},{x:60,y:295},{x:130,y:170}],
     exitX:130,exitY:170,exitVx:3.5,exitVy:0,z:1,color:'#664400',lit:false,litTimer:0,travelMs:800,label:'KITCHEN!'},
    {type:'orbit',side:'right',
     path:[{x:398,y:650},{x:426,y:470},{x:420,y:295},{x:350,y:170}],
     exitX:350,exitY:170,exitVx:-3.5,exitVy:0,z:1,color:'#446600',lit:false,litTimer:0,travelMs:800,label:'ORDER UP!'},
  ];

  const locks=[
    {x:240,y:560,r:20,locked:false,color:'#ff8800',label:'APRON SAVE'},
  ];

  const kickers=[
    // Ball popper behind the bar
    {x:240,y:108,r:18,vx:0,vy:-9,pts:2000,color:'#ffcc00',label:'BAR SHOT'},
  ];

  const wormHoles=[];

  const lights=buildNeonLights();
  const arrows=[
    {x:95,y:630,angle:-0.35,color:'#ff8800',lit:false,label:'KITCHEN'},
    {x:385,y:630,angle:Math.PI+0.35,color:'#44cc00',lit:false,label:'ORDER'},
    {x:232,y:508,angle:-Math.PI/2,color:'#ffdd00',lit:false,label:'STARS'},
  ];

  return {
    id:'barfs_house',
    flippers,bumpers,slings,targets,dropBanks,ramps,wormHoles,locks,kickers,lights,arrows,
    wallColor:'#1a0800',railColor:'#aa5500',fieldColor:'#090400',
    inlaneColor:'#662200',slingsColor:'#993300',
    drawBg: drawBHBg,
    logic: bhLogic,
    onBumper: bhOnBumper,
    onGroup: bhOnGroup,
  };
}

function buildNeonLights(){
  const l=[];
  const cols=['#ff6600','#ffdd00','#ff4400','#44ff00','#ff0044'];
  for(let i=0;i<28;i++){
    l.push({x:70+Math.random()*340,y:100+Math.random()*630,
      r:3+Math.random()*4,color:cols[i%5],
      phase:Math.random()*Math.PI*2,speed:0.03+Math.random()*0.06,type:'neon'});
  }
  [670,700,730].forEach((y,i)=>{
    l.push({x:84,y,r:6,color:'#ff8800',phase:i*0.7,speed:0.05,type:'inlane'});
    l.push({x:396,y,r:6,color:'#44cc00',phase:i*0.7,speed:0.05,type:'inlane'});
  });
  return l;
}

function bhLogic(dt){
  // Laugh track dots flash on combos
  if(_pb.combo>3){
    if(Math.floor(_pb.phaseTimer*6)%2===0){
      _pb.strobes.push({x:PB.W/2,y:72,r:200,life:0.05,max:0.05,color:'rgba(255,220,100,0.06)'});
    }
  }
}
function bhOnBumper(b){
  _pb.tableProgress.orders=(_pb.tableProgress.orders||0)+1;
  if(_pb.tableProgress.orders%12===0) startMultiball(1);
}
function bhOnGroup(group){
  if(group==='serve') triggerMode('servingTime',22,'SERVE CHICKEN!');
  if(group==='chicken') triggerMode('kitchenChaos',30,'KITCHEN CHAOS!');
  if(group==='stars'){_pb.multiplier=Math.min(_pb.multiplier+1,5);dmd('SATISFACTION +1!','');}
  if(group==='kitchen') triggerMode('healthInspector',15,'HEALTH INSPECTION!');
  if(group==='jackpot'){addPts(20000*_pb.multiplier,PB.W/2,100);dmd("BARF'S SPECIAL!",'JACKPOT!');}
}

// ════════════════════════════════════════════════════════
// SHOWER DEFENSE
// ════════════════════════════════════════════════════════
function tableShowerDefense(){
  const flippers=stdFlippers([
    // Side tub flipper (right side, points up)
    {x:432,y:480,angle:-Math.PI*0.55,len:54,w:9,side:'right',active:false,z:0,sideFlipper:true},
  ]);

  const bumpers=[
    {x:162,y:195,r:26,label:'SOAP',   pts:100,color:'#aaddff',ring:'#ddeeff',hits:0,flashTimer:0,cooldown:0},
    {x:300,y:172,r:26,label:'DUCK!',  pts:150,color:'#ffdd00',ring:'#ffe880',hits:0,flashTimer:0,cooldown:0},
    {x:378,y:222,r:22,label:'LOOFAH', pts:100,color:'#ff88aa',ring:'#ffbbcc',hits:0,flashTimer:0,cooldown:0},
    {x:200,y:272,r:20,label:'PLUNGE', pts:200,color:'#6688ff',ring:'#aabbff',hits:0,flashTimer:0,cooldown:0},
    {x:328,y:302,r:20,label:'SCRUB',  pts:200,color:'#44ccff',ring:'#88ddff',hits:0,flashTimer:0,cooldown:0},
    {x:145,y:338,r:20,label:'RINSE',  pts:300,color:'#00ccff',ring:'#66ddff',hits:0,flashTimer:0,cooldown:0},
    {x:252,y:148,r:18,label:'SPONGE', pts:250,color:'#ffcc88',ring:'#ffddb0',hits:0,flashTimer:0,cooldown:0},
  ];

  const slings=[
    {x:56, y:570,w:24,h:90,kickVx:8, kickVy:-4.5,color:'#0088ff',pts:50},
    {x:400,y:570,w:24,h:90,kickVx:-8,kickVy:-4.5,color:'#00ccff',pts:50},
  ];

  const dropBanks=[
    {label:'DRAIN',targets:[
      {x:66,y:410,w:16,h:32,label:'D',pts:300,color:'#0088ff',hit:false,flashTimer:0,group:'drain'},
      {x:66,y:446,w:16,h:32,label:'R',pts:300,color:'#0088ff',hit:false,flashTimer:0,group:'drain'},
      {x:66,y:482,w:16,h:32,label:'A',pts:300,color:'#0088ff',hit:false,flashTimer:0,group:'drain'},
      {x:66,y:518,w:16,h:32,label:'I',pts:300,color:'#0088ff',hit:false,flashTimer:0,group:'drain'},
      {x:66,y:554,w:16,h:32,label:'N',pts:300,color:'#0088ff',hit:false,flashTimer:0,group:'drain'},
    ]},
    {label:'CLEAN',targets:[
      {x:398,y:410,w:16,h:32,label:'C',pts:400,color:'#00ccff',hit:false,flashTimer:0,group:'clean'},
      {x:398,y:446,w:16,h:32,label:'L',pts:400,color:'#00ccff',hit:false,flashTimer:0,group:'clean'},
      {x:398,y:482,w:16,h:32,label:'E',pts:400,color:'#00ccff',hit:false,flashTimer:0,group:'clean'},
      {x:398,y:518,w:16,h:32,label:'A',pts:400,color:'#00ccff',hit:false,flashTimer:0,group:'clean'},
      {x:398,y:554,w:16,h:32,label:'N',pts:400,color:'#00ccff',hit:false,flashTimer:0,group:'clean'},
    ]},
  ];

  const targets=[
    // Water drop bonus targets
    {x:170,y:440,w:16,h:28,label:'💧',pts:800,color:'#44aaff',hit:false,flashTimer:0,group:'drops'},
    {x:192,y:440,w:16,h:28,label:'💧',pts:800,color:'#44aaff',hit:false,flashTimer:0,group:'drops'},
    {x:214,y:440,w:16,h:28,label:'💧',pts:800,color:'#44aaff',hit:false,flashTimer:0,group:'drops'},
    {x:236,y:440,w:16,h:28,label:'💧',pts:800,color:'#44aaff',hit:false,flashTimer:0,group:'drops'},
    // Skill shot
    {x:220,y:95, w:20,h:14,label:'🚿',pts:3000,color:'#00ffcc',hit:false,flashTimer:0,group:'skillshot'},
    // Soap scum boss targets
    {x:153,y:355,w:14,h:24,label:'SCM',pts:500,color:'#88aa66',hit:false,flashTimer:0,group:'scum'},
    {x:315,y:360,w:14,h:24,label:'SCM',pts:500,color:'#88aa66',hit:false,flashTimer:0,group:'scum'},
  ];

  const ramps=[
    {type:'orbit',side:'left',
     path:[{x:82,y:648},{x:54,y:465},{x:58,y:265},{x:138,y:155}],
     exitX:138,exitY:155,exitVx:2.8,exitVy:0.3,z:1,color:'#005588',lit:false,litTimer:0,travelMs:820,label:'SHOWER'},
    {type:'loop',side:'right',
     path:[{x:398,y:648},{x:426,y:465},{x:422,y:265},{x:342,y:155}],
     exitX:342,exitY:155,exitVx:-2.8,exitVy:0.3,z:1,color:'#006688',lit:false,litTimer:0,travelMs:820,label:'TUB LOOP'},
    // Center shower head loop
    {type:'center',
     path:[{x:205,y:375},{x:205,y:270},{x:275,y:270},{x:275,y:375}],
     exitX:275,exitY:380,exitVx:1.5,exitVy:2.5,z:1,color:'#004466',lit:false,litTimer:0,travelMs:650,label:'DRAIN LOOP'},
  ];

  const locks=[
    {x:240,y:552,r:20,locked:false,color:'#00ccff',label:'DRAIN LOCK'},
  ];

  const kickers=[
    {x:240,y:105,r:16,vx:0,vy:-9,pts:1500,color:'#00ffcc',label:'SHOWER HEAD'},
  ];

  const wormHoles=[];

  const lights=buildWaterLights();
  const arrows=[
    {x:96,y:628,angle:-0.38,color:'#0088ff',lit:false,label:'SHOWER'},
    {x:384,y:628,angle:Math.PI+0.38,color:'#00ccff',lit:false,label:'TUB'},
    {x:220,y:420,angle:-Math.PI/2,color:'#44aaff',lit:false,label:'DROPS'},
    {x:240,y:530,angle:-Math.PI/2,color:'#00ffcc',lit:false,label:'LOCK'},
  ];

  return {
    id:'shower_defense',
    flippers,bumpers,slings,targets,dropBanks,ramps,wormHoles,locks,kickers,lights,arrows,
    wallColor:'#001820',railColor:'#005588',fieldColor:'#000e16',
    inlaneColor:'#003366',slingsColor:'#005599',
    drawBg: drawSDBg,
    logic: sdLogic,
    onBumper: sdOnBumper,
    onGroup: sdOnGroup,
  };
}

function buildWaterLights(){
  const l=[];
  for(let i=0;i<28;i++){
    l.push({x:65+Math.random()*350,y:100+Math.random()*650,
      r:2+Math.random()*3,color:['#aaddff','#44ccff','#00aaff','#66ddff'][i%4],
      phase:Math.random()*Math.PI*2,speed:0.02+Math.random()*0.04,type:'water'});
  }
  [670,700,730].forEach((y,i)=>{
    l.push({x:84,y,r:6,color:'#0088ff',phase:i*0.8,speed:0.04,type:'inlane'});
    l.push({x:396,y,r:6,color:'#00ccff',phase:i*0.8,speed:0.04,type:'inlane'});
  });
  return l;
}

function sdLogic(dt){
  // Grime meter builds slowly
  if(_pb.phase==='play'){
    _pb.tableProgress.grime=Math.min(100,(_pb.tableProgress.grime||0)+0.008*dt);
  }
  // Current in shower zone — rightward drift
  if(_pb.ball.active&&_pb.ball.y<PB.H*0.38){
    _pb.ball.vx+=0.035*dt;
  }
}
function sdOnBumper(b){
  _pb.tableProgress.grime=Math.max(0,(_pb.tableProgress.grime||0)-2);
}
function sdOnGroup(group){
  if(group==='drain') triggerMode('unclogDrain',22,'SHOOT THE RAMP!');
  if(group==='clean'){triggerMode('deepClean',25,'DEEP CLEAN MODE!');_pb.tableProgress.grime=0;}
  if(group==='drops') startMultiball(2);
  if(group==='scum'){addPts(10000*_pb.multiplier,PB.W/2,300);dmd('SCUM BOSS DEFEATED!','');}
  if(group==='skillshot'){addPts(5000*_pb.multiplier,PB.W/2,95);dmd('SKILL SHOT!','NICE AIM!');}
}

// ─── DRAW ─────────────────────────────────────────────────────────────────────
function draw(){
  if(!_ctx||!_table)return;
  const ctx=_ctx;
  ctx.clearRect(0,0,PB.W,PB.H);
  drawField(ctx);
  _table.drawBg(ctx);
  drawLights(ctx);
  drawSlingshots(ctx);
  drawRamps(ctx);
  drawDropBanks(ctx);
  drawBumpers(ctx);
  drawTargets(ctx);
  drawWHOnField(ctx);
  drawLocks(ctx);
  drawKickers(ctx);
  drawArrows(ctx);
  drawFlippers(ctx);
  drawPlunger(ctx);
  drawStrobes(ctx);
  [_pb.ball,..._pb.extras].forEach(b=>drawBall(ctx,b));
  drawPulses(ctx);
  drawHUD(ctx);
}

function drawField(ctx){
  const t=_table;
  ctx.fillStyle=t.fieldColor||'#000008';
  ctx.fillRect(0,0,PB.W,PB.H);
  // Side walls
  ctx.fillStyle=t.wallColor||'#06061a';
  ctx.fillRect(0,0,wallL,PB.H); ctx.fillRect(wallR,0,PB.W-wallR,PB.H);
  // Rail
  ctx.fillStyle=t.railColor||'#0022aa';
  ctx.fillRect(wallL-4,0,4,PB.H); ctx.fillRect(wallR,0,4,PB.H);
  // Inlane guide lines (upper section only — below this is open gutter)
  ctx.strokeStyle=t.inlaneColor||'#001166';
  ctx.lineWidth=3;
  ctx.beginPath();ctx.moveTo(inlaneL,FL.y-30);ctx.lineTo(inlaneL,FL.y-220);ctx.stroke();
  ctx.beginPath();ctx.moveTo(inlaneR,FL.y-30);ctx.lineTo(inlaneR,FL.y-220);ctx.stroke();

  // Bottom section: angled guide rails from wall to flipper pivot area
  // These are the slanted walls that funnel ball toward flippers
  ctx.strokeStyle=t.railColor||'#0022aa';
  ctx.lineWidth=5; ctx.lineCap='round';
  // Left guide rail: from wallL down to just left of left pivot
  ctx.beginPath();
  ctx.moveTo(inlaneL, FL.y - 30);
  ctx.lineTo(wallL+2, FL.y + 40);
  ctx.stroke();
  // Right guide rail
  ctx.beginPath();
  ctx.moveTo(inlaneR, FL.y - 30);
  ctx.lineTo(wallR-2, FL.y + 40);
  ctx.stroke();

  // Solid drain wall below flippers (ball disappears here)
  ctx.fillStyle=t.wallColor||'#06061a';
  ctx.fillRect(0, DRAIN_Y+2, PB.W, PB.H-DRAIN_Y);

  // Center drain slot visual (very subtle)
  ctx.fillStyle='rgba(255,0,0,0.08)';
  const tipL = FL.leftX + FL.len*Math.cos(FL.REST_L);
  const tipR = FL.rightX + FL.len*Math.cos(FL.REST_R);
  ctx.fillRect(tipL, FL.y+10, tipR-tipL, DRAIN_Y-FL.y-10);
  // Plunger lane
  ctx.fillStyle='rgba(255,255,255,0.025)';
  ctx.fillRect(wallR,PB.H-270,PB.W-wallR,270);
  // Plunger lane exit arc at TOP — curved guide that routes ball onto playfield
  // This is the most important visual: player sees where ball will exit
  ctx.strokeStyle=t.railColor||'#0022aa';
  ctx.lineWidth=6; ctx.lineCap='round';
  // Main curved guide: from top of lane wall, sweeps left onto playfield
  ctx.beginPath();
  ctx.moveTo(wallR+2, 125);              // top of lane wall
  ctx.quadraticCurveTo(wallR+2, wallT+8, wallR-55, wallT+8); // curves left along top
  ctx.stroke();
  // Bright highlight on the curve so it's clearly visible
  ctx.strokeStyle='rgba(255,255,255,0.18)';
  ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(wallR+2, 125);
  ctx.quadraticCurveTo(wallR+2, wallT+8, wallR-55, wallT+8);
  ctx.stroke();
  // Small arrow showing exit direction
  ctx.fillStyle=t.railColor||'#0022aa';
  ctx.beginPath();
  ctx.moveTo(wallR-55, wallT+4);
  ctx.lineTo(wallR-65, wallT+12);
  ctx.lineTo(wallR-55, wallT+16);
  ctx.fill();
  // Center divider line
  ctx.strokeStyle='rgba(255,255,255,0.03)';
  ctx.lineWidth=1; ctx.setLineDash([3,6]);
  ctx.beginPath();ctx.moveTo(PB.W/2,wallT);ctx.lineTo(PB.W/2,PB.H-200);ctx.stroke();
  ctx.setLineDash([]);
}

function drawSlingshots(ctx){
  _pb.slings.forEach(s=>{
    ctx.fillStyle=s.color||'#4488ff';
    ctx.globalAlpha=0.7;
    // Triangular slingshot shape
    if(s.kickVx>0){// left side
      ctx.beginPath();ctx.moveTo(s.x,s.y);ctx.lineTo(s.x+s.w,s.y+s.h*0.5);ctx.lineTo(s.x,s.y+s.h);ctx.fill();
    } else {// right side
      ctx.beginPath();ctx.moveTo(s.x+s.w,s.y);ctx.lineTo(s.x,s.y+s.h*0.5);ctx.lineTo(s.x+s.w,s.y+s.h);ctx.fill();
    }
    ctx.globalAlpha=1;
    // Edge highlight
    ctx.strokeStyle=s.color; ctx.lineWidth=2;
    ctx.strokeRect(s.x,s.y,s.w,s.h);
  });
}

function drawRamps(ctx){
  _pb.ramps.forEach(r=>{
    const lit=r.lit;
    const t=_pb.phaseTimer;

    // 3D shadow underneath ramp (gives height illusion)
    ctx.globalAlpha=0.35;
    ctx.strokeStyle='rgba(0,0,0,0.8)';
    ctx.lineWidth=18; ctx.lineCap='round';
    ctx.beginPath();
    r.path.forEach((p,i)=>i===0?ctx.moveTo(p.x+3,p.y+5):ctx.lineTo(p.x+3,p.y+5));
    ctx.stroke();

    // Ramp body — wide, colored, shows elevation
    ctx.globalAlpha=lit?0.88:0.52;
    ctx.strokeStyle=r.color;
    ctx.lineWidth=16; ctx.lineCap='round';
    ctx.beginPath();
    r.path.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
    ctx.stroke();

    // Dark edge (bottom of ramp — thickness illusion)
    ctx.globalAlpha=lit?0.6:0.3;
    ctx.strokeStyle=dkn(r.color,0.5);
    ctx.lineWidth=18; ctx.lineCap='round';
    ctx.lineJoin='round';
    // Offset slightly down
    ctx.beginPath();
    r.path.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y+4):ctx.lineTo(p.x,p.y+4));
    ctx.stroke();

    // Top highlight (light catching ramp surface)
    ctx.globalAlpha=lit?0.6:0.18;
    ctx.strokeStyle='rgba(255,255,255,0.9)';
    ctx.lineWidth=3;
    ctx.beginPath();
    r.path.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y-2):ctx.lineTo(p.x,p.y-2));
    ctx.stroke();

    // Animated travel arrows when lit
    if(lit){
      const arrowAnim=Math.floor(t*6)%r.path.length;
      r.path.forEach((p,i)=>{
        const active=i===arrowAnim;
        ctx.globalAlpha=active?1:0.45;
        ctx.fillStyle=active?'#ffffff':lhn(r.color,0.3);
        ctx.font=`bold ${active?13:10}px monospace`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.shadowColor=active?'#fff':'transparent';
        ctx.shadowBlur=active?8:0;
        ctx.fillText('▲',p.x,p.y-8);
        ctx.shadowBlur=0;
      });
    }

    ctx.globalAlpha=1;

    // Entry indicator — glowing circle at ramp mouth
    const ep=r.path[0];
    ctx.strokeStyle=lit?'#ffffff':r.color;
    ctx.lineWidth=2;
    ctx.shadowColor=r.color; ctx.shadowBlur=lit?12:4;
    ctx.beginPath();ctx.arc(ep.x,ep.y,10,0,Math.PI*2);ctx.stroke();
    ctx.shadowBlur=0;

    // Label at entry
    if(r.label){
      const side=ep.x<PB.W/2;
      ctx.fillStyle=lit?'#fff':'rgba(200,200,255,0.55)';
      ctx.font='bold 8px monospace'; ctx.textAlign='center';
      ctx.shadowColor=r.color; ctx.shadowBlur=lit?6:0;
      ctx.fillText(r.label,ep.x+(side?22:-22),ep.y-4);
      ctx.shadowBlur=0;
    }

    // Exit point marker
    const ex=r.exitX,ey=r.exitY;
    ctx.globalAlpha=0.5;
    ctx.fillStyle=r.color;
    ctx.beginPath();ctx.arc(ex,ey,5,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;
  });
}

function drawDropBanks(ctx){
  _pb.dropBanks.forEach(bank=>{
    bank.targets.forEach(t=>{
      const flash=t.flashTimer>0;
      ctx.fillStyle=t.hit?(flash?t.color:'#222'):t.color;
      ctx.shadowColor=flash?'#fff':t.color;
      ctx.shadowBlur=flash?15:5;
      ctx.fillRect(t.x,t.y,t.w,t.h);
      ctx.shadowBlur=0;
      ctx.fillStyle=t.hit?'#555':'#fff';
      ctx.font=`bold ${Math.min(t.w,t.h)*0.65}px monospace`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(t.label,t.x+t.w/2,t.y+t.h/2);
    });
  });
}

function drawBumpers(ctx){
  _pb.bumpers.forEach(b=>{
    const f=b.flashTimer>0;
    const pulse=0.5+0.5*Math.sin(_pb.phaseTimer*6);
    if(f){ctx.shadowColor=b.ring;ctx.shadowBlur=30;}
    // Outer glow ring
    ctx.strokeStyle=f?'#ffffff':b.ring;
    ctx.lineWidth=f?4:2.5;
    ctx.beginPath();ctx.arc(b.x,b.y,b.r+5+(f?4*pulse:0),0,Math.PI*2);ctx.stroke();
    ctx.shadowBlur=0;
    // Body gradient
    const gr=ctx.createRadialGradient(b.x-b.r*0.3,b.y-b.r*0.35,0,b.x,b.y,b.r);
    gr.addColorStop(0,f?'#ffffff':lhn(b.color,0.5));
    gr.addColorStop(0.5,f?b.ring:b.color);
    gr.addColorStop(1,dkn(b.color,0.4));
    ctx.fillStyle=gr;
    ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();
    // Label
    ctx.fillStyle=f?'#000':'#fff';
    ctx.font=`bold ${Math.max(7,Math.floor(b.r*0.48))}px monospace`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(b.label,b.x,b.y);
    // Hit counter
    if(b.hits>0){
      ctx.fillStyle='rgba(255,255,255,0.35)';
      ctx.font='6px monospace';
      ctx.fillText(b.hits,b.x+b.r*0.65,b.y-b.r*0.65);
    }
  });
}

function drawTargets(ctx){
  _pb.targets.forEach(t=>{
    const f=t.flashTimer>0;
    ctx.fillStyle=t.hit?(f?t.color:'#1a1a1a'):t.color;
    ctx.shadowColor=f?'#fff':t.color; ctx.shadowBlur=f?12:4;
    ctx.fillRect(t.x,t.y,t.w,t.h);
    ctx.shadowBlur=0;
    ctx.fillStyle=t.hit?'#444':'#fff';
    ctx.font=`bold ${Math.min(t.w,t.h)*0.68}px monospace`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(t.label,t.x+t.w/2,t.y+t.h/2);
  });
}

function drawWHOnField(ctx){
  if(_table.id!=='worm_holer')return;
  _pb.wormHoles.forEach(w=>{
    const t=_pb.phaseTimer,spin=t*(w.active?2.5:0.4);
    for(let i=0;i<(w.active?7:3);i++){
      const a=spin+i*(Math.PI*2/7);
      ctx.strokeStyle=w.active
        ?`hsla(${270+i*18},100%,65%,${0.7-i*0.08})`
        :`rgba(100,80,180,${0.15-i*0.03})`;
      ctx.lineWidth=1.8;
      ctx.beginPath();
      ctx.arc(w.x,w.y,w.r*(0.3+i*0.1),a,a+Math.PI*(1.5-i*0.15));
      ctx.stroke();
    }
    ctx.fillStyle=w.active?w.color:'#111';
    ctx.shadowColor=w.active?w.color:'transparent';
    ctx.shadowBlur=w.active?18:0;
    ctx.beginPath();ctx.arc(w.x,w.y,w.r*0.38,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;
    ctx.fillStyle=w.active?'#fff':'#444';
    ctx.font='7px monospace'; ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(w.label,w.x,w.y+w.r+9);
  });
}

function drawLocks(ctx){
  _pb.locks.forEach(lk=>{
    const t=_pb.phaseTimer;
    ctx.strokeStyle=lk.locked?'#888':lk.color;
    ctx.lineWidth=2.5;
    ctx.shadowColor=lk.locked?'transparent':lk.color;
    ctx.shadowBlur=lk.locked?0:8+4*Math.sin(t*3);
    ctx.beginPath();ctx.arc(lk.x,lk.y,lk.r,0,Math.PI*2);ctx.stroke();
    ctx.shadowBlur=0;
    ctx.fillStyle=lk.locked?'rgba(255,255,255,0.1)':'rgba(0,0,0,0.3)';
    ctx.beginPath();ctx.arc(lk.x,lk.y,lk.r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=lk.locked?'#888':lk.color;
    ctx.font='7px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(lk.locked?'LOCKED':lk.label,lk.x,lk.y);
  });
}

function drawKickers(ctx){
  _pb.kickers.forEach(k=>{
    const t=_pb.phaseTimer;
    ctx.strokeStyle=k.color; ctx.lineWidth=2.5;
    ctx.shadowColor=k.color; ctx.shadowBlur=8+3*Math.sin(t*4);
    ctx.beginPath();ctx.arc(k.x,k.y,k.r,0,Math.PI*2);ctx.stroke();
    ctx.shadowBlur=0;
    const gr=ctx.createRadialGradient(k.x,k.y,0,k.x,k.y,k.r);
    gr.addColorStop(0,'rgba(255,255,255,0.15)'); gr.addColorStop(1,'rgba(0,0,0,0.4)');
    ctx.fillStyle=gr; ctx.beginPath();ctx.arc(k.x,k.y,k.r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=k.color; ctx.font='7px monospace';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillText(k.label,k.x,k.y+k.r+8);
  });
}

function drawArrows(ctx){
  _pb.arrows.forEach(a=>{
    const lit=a.lit||(_pb.modeActive&&Math.sin(_pb.phaseTimer*5)>0);
    ctx.fillStyle=lit?a.color:'rgba(100,100,100,0.3)';
    ctx.shadowColor=lit?a.color:'transparent'; ctx.shadowBlur=lit?8:0;
    ctx.save();
    ctx.translate(a.x,a.y); ctx.rotate(a.angle);
    ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(6,6);ctx.lineTo(-6,6);ctx.closePath();
    ctx.fill(); ctx.shadowBlur=0; ctx.restore();
    if(a.label&&lit){
      ctx.fillStyle=a.color; ctx.font='6px monospace';
      ctx.textAlign='center'; ctx.fillText(a.label,a.x,a.y+14);
    }
  });
}

function drawLights(ctx){
  _pb.lights.forEach(l=>{
    const br=0.25+0.35*Math.abs(Math.sin(l.phase));
    ctx.globalAlpha=br;
    if(l.type==='inlane'){
      ctx.fillStyle=l.color;
      ctx.shadowColor=l.color; ctx.shadowBlur=6;
      ctx.beginPath();ctx.arc(l.x,l.y,l.r,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;
    } else {
      ctx.fillStyle=l.color;
      ctx.beginPath();ctx.arc(l.x,l.y,l.r,0,Math.PI*2);ctx.fill();
    }
    ctx.globalAlpha=1;
  });
}

function drawStrobes(ctx){
  _pb.strobes.forEach(s=>{
    const p=s.life/s.max;
    ctx.globalAlpha=p*0.55;
    const gr=ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,s.r);
    gr.addColorStop(0,s.color||'#fff');
    gr.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=gr;
    ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=1;
  });
}

function drawFlippers(ctx){
  _pb.flippers.forEach(f=>{
    const a  = flipAngle(f);
    const tx = f.x + FL.len*Math.cos(a);
    const ty = f.y + FL.len*Math.sin(a);
    const ac = _tdef?.accentColor||'#4488ff';
    // Flipper body
    ctx.strokeStyle = f.active ? '#ffffff' : ac;
    ctx.lineWidth   = FL.w;
    ctx.lineCap     = 'round';
    ctx.shadowColor = f.active ? '#ffffff' : ac;
    ctx.shadowBlur  = f.active ? 18 : 6;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Pivot circle
    ctx.fillStyle  = '#ccc';
    ctx.strokeStyle= f.active ? '#fff' : ac;
    ctx.lineWidth  = 2;
    ctx.beginPath();
    ctx.arc(f.x, f.y, FL.w/2+3, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    // Tip circle
    ctx.fillStyle = f.active ? '#fff' : lhn(ac,0.3);
    ctx.beginPath();
    ctx.arc(tx, ty, FL.w/2, 0, Math.PI*2);
    ctx.fill();
  });
}

function drawPlunger(ctx){
  if(_pb.phase!=='plunge')return;
  const px=PB.W-26, laneBot=PB.H-90, laneTop=90;
  const laneH=laneBot-laneTop;
  const charge=_pb.plungerCharge/PB.PLUNGER_MAX;
  const springH=charge*laneH*0.6;
  const springY=laneBot-springH;
  const ballY=springY-9-PB.BALL_R; // ball center above plunger head

  // Lane track (full height guide rail)
  ctx.strokeStyle='#1a1a1a';ctx.lineWidth=8;ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(px,laneTop);ctx.lineTo(px,laneBot);ctx.stroke();

  // Spring coil visual (below plunger head)
  ctx.strokeStyle='#333';ctx.lineWidth=3;
  for(let sy=springY+12;sy<laneBot-8;sy+=10){
    ctx.beginPath();ctx.moveTo(px-5,sy);ctx.lineTo(px+5,sy+5);ctx.stroke();
  }

  // Spring compression bar (power indicator)
  const col=charge<0.4?'#44ff88':charge<0.75?'#ffcc00':'#ff4400';
  ctx.strokeStyle=col;ctx.lineWidth=6;
  ctx.shadowColor=col;ctx.shadowBlur=12;
  ctx.beginPath();ctx.moveTo(px,laneBot);ctx.lineTo(px,springY);ctx.stroke();
  ctx.shadowBlur=0;

  // Plunger head disk
  ctx.fillStyle='#cccccc';ctx.strokeStyle=col;ctx.lineWidth=2.5;
  ctx.shadowColor=col;ctx.shadowBlur=8;
  ctx.beginPath();ctx.arc(px,springY,9,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.shadowBlur=0;

  // Ball sitting ON the plunger head — moves with it
  // (ball.y is set in updatePlunge, we just draw it here visually)
  const bc=_tdef?.ballColor||'#c0e0ff';
  const gr=ctx.createRadialGradient(px-3,ballY-3,0,px,ballY,PB.BALL_R);
  gr.addColorStop(0,'#fff');gr.addColorStop(0.35,bc);gr.addColorStop(1,dkn(bc,0.5));
  ctx.fillStyle=gr;ctx.shadowColor=bc;ctx.shadowBlur=10;
  ctx.beginPath();ctx.arc(px,ballY,PB.BALL_R,0,Math.PI*2);ctx.fill();
  ctx.shadowBlur=0;
  // Ball specular
  ctx.fillStyle='rgba(255,255,255,0.6)';
  ctx.beginPath();ctx.arc(px-3,ballY-3,PB.BALL_R*0.28,0,Math.PI*2);ctx.fill();

  // Hint text below plunger
  if(charge<0.05){
    ctx.fillStyle='rgba(255,255,255,0.35)';ctx.font='8px monospace';ctx.textAlign='center';
    ctx.fillText('HOLD LAUNCH',px,laneBot+14);
  } else {
    ctx.fillStyle=col;ctx.font='bold 9px monospace';ctx.textAlign='center';
    ctx.shadowColor=col;ctx.shadowBlur=6;
    ctx.fillText('RELEASE!',px,laneBot+14);
    ctx.shadowBlur=0;
  }
}

function drawBall(ctx,b){
  if(!b.active||b.lost)return;
  const alpha=b.z>0?0.5:1;
  const r=PB.BALL_R*(1+b.z*0.1);
  ctx.globalAlpha=alpha;
  if(b.z>0){
    ctx.fillStyle='rgba(0,0,0,0.4)';
    ctx.beginPath();ctx.ellipse(b.x+b.z*4,b.y+b.z*6,r*0.85,r*0.45,0,0,Math.PI*2);ctx.fill();
  }
  const bc=_tdef?.ballColor||'#c0e0ff';
  const gr=ctx.createRadialGradient(b.x-r*0.3,b.y-r*0.3,0,b.x,b.y,r);
  gr.addColorStop(0,'#ffffff');gr.addColorStop(0.3,bc);gr.addColorStop(1,dkn(bc,0.5));
  ctx.fillStyle=gr;ctx.shadowColor=bc;ctx.shadowBlur=10;
  ctx.beginPath();ctx.arc(b.x,b.y,r,0,Math.PI*2);ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='rgba(255,255,255,0.6)';
  ctx.beginPath();ctx.arc(b.x-r*0.3,b.y-r*0.32,r*0.27,0,Math.PI*2);ctx.fill();
  ctx.globalAlpha=1;
}

function drawPulses(ctx){
  _pb.pulses.forEach(p=>{
    const pct=p.life/p.max;
    if(p.type==='score'){
      ctx.globalAlpha=pct;
      ctx.fillStyle='#ffdd00';
      ctx.font=`bold ${11+(1-pct)*8}px monospace`;
      ctx.textAlign='center';
      ctx.fillText('+'+p.pts.toLocaleString(),p.x,p.y-(1-pct)*38);
      ctx.globalAlpha=1;
    } else if(p.type==='ring'){
      ctx.globalAlpha=pct*0.7;
      ctx.strokeStyle=p.color||'#fff';ctx.lineWidth=3;
      ctx.shadowColor=p.color;ctx.shadowBlur=10;
      ctx.beginPath();ctx.arc(p.x,p.y,p.r+(1-pct)*24,0,Math.PI*2);ctx.stroke();
      ctx.shadowBlur=0;ctx.globalAlpha=1;
    } else if(p.type==='fill'){
      ctx.globalAlpha=pct*0.8;
      ctx.fillStyle=p.color||'#fff';
      ctx.beginPath();ctx.arc(p.x,p.y,p.r+(1-pct)*15,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=1;
    }
  });
}

function drawHUD(ctx){
  // Top bar
  ctx.fillStyle='rgba(0,0,0,0.55)';ctx.fillRect(0,0,PB.W,20);
  ctx.fillStyle=_tdef?.accentColor||'#ffdd00';
  ctx.font='bold 11px monospace';ctx.textAlign='left';
  ctx.fillText(_tdef?.name||'PINBALL',50,14);
  ctx.textAlign='right';ctx.fillStyle='#ffdd00';
  ctx.fillText(_pb.score.toLocaleString(),PB.W-50,14);
  ctx.textAlign='center';ctx.fillStyle='#888';ctx.font='10px monospace';
  ctx.fillText('BALL '+_pb.ballNum+'/3',PB.W/2,14);
  if(_pb.multiplier>1){
    ctx.fillStyle='#ff8800';ctx.font='bold 9px monospace';ctx.textAlign='left';
    ctx.fillText(_pb.multiplier+'×',50,26);
  }
  // Mode bar
  if(_pb.modeActive&&_pb.modeTimer>0){
    const pct=_pb.modeTimer/30;
    ctx.fillStyle='rgba(255,80,0,0.22)';ctx.fillRect(wallL,PB.H-16,pct*(wallR-wallL),8);
    ctx.strokeStyle='#ff6600';ctx.lineWidth=1;ctx.strokeRect(wallL,PB.H-16,wallR-wallL,8);
  }
  // Game over / scores overlay
  if(_pb.phase==='gameover'||_pb.phase==='scores'){
    ctx.fillStyle='rgba(0,0,0,0.78)';ctx.fillRect(0,0,PB.W,PB.H);
    ctx.textAlign='center';
    ctx.fillStyle=_tdef?.accentColor||'#ff4400';
    ctx.font='bold 30px monospace';ctx.fillText('GAME OVER',PB.W/2,PB.H/2-90);
    ctx.fillStyle='#ffdd00';ctx.font='bold 22px monospace';
    ctx.fillText(_pb.score.toLocaleString(),PB.W/2,PB.H/2-52);
    if(_pb.phase==='scores'){
      ctx.fillStyle='#ffaa00';ctx.font='bold 13px monospace';
      ctx.fillText('HIGH SCORES',PB.W/2,PB.H/2-18);
      _pb.highScores.slice(0,5).forEach((s,i)=>{
        ctx.fillStyle=i===0?'#ffdd00':'#666';
        ctx.font=(i===0?'bold ':'')+' 11px monospace';
        ctx.fillText((i+1)+'. '+s.score.toLocaleString(),PB.W/2,PB.H/2+4+i*18);
      });
      if(_pb.lastMatch){
        ctx.fillStyle=_pb.lastMatch.won?'#44ff88':'#666';
        ctx.font='10px monospace';
        ctx.fillText(_pb.lastMatch.won?'★ MATCH! FREE GAME! ★':'MATCH: '+_pb.lastMatch.match,PB.W/2,PB.H/2+108);
      }
      ctx.fillStyle='rgba(255,255,255,0.3)';ctx.font='9px monospace';
      ctx.fillText('PRESS ANY BUTTON TO PLAY AGAIN',PB.W/2,PB.H-28);
    }
  }
  if(_pb.phase==='lost'){
    ctx.fillStyle='rgba(0,0,0,0.55)';ctx.fillRect(0,PB.H/2-30,PB.W,55);
    ctx.textAlign='center';ctx.fillStyle='#ff4400';
    ctx.font='bold 20px monospace';ctx.fillText('BALL LOST!',PB.W/2,PB.H/2-8);
    ctx.fillStyle='#888';ctx.font='10px monospace';
    ctx.fillText(_pb.ballsLeft+' ball'+(+_pb.ballsLeft!==1?'s':'')+' remaining',PB.W/2,PB.H/2+12);
  }
}

// ─── TABLE BACKGROUND DRAWS ───────────────────────────────────────────────────
function drawWHBg(ctx){
  const t=_pb.phaseTimer;
  const gr=ctx.createRadialGradient(PB.W/2,PB.H*0.28,10,PB.W/2,PB.H*0.28,220);
  gr.addColorStop(0,`rgba(30,0,70,${0.07+0.03*Math.sin(t)})`);
  gr.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=gr;ctx.fillRect(0,0,PB.W,PB.H);
}
function drawBHBg(ctx){
  const t=_pb.phaseTimer;
  const gr=ctx.createRadialGradient(PB.W/2,PB.H*0.38,10,PB.W/2,PB.H*0.38,200);
  gr.addColorStop(0,`rgba(70,25,0,${0.1+0.04*Math.sin(t*2)})`);
  gr.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=gr;ctx.fillRect(0,0,PB.W,PB.H);
  // Barf's House sign
  ctx.fillStyle=`rgba(255,120,0,${0.14+0.06*Math.abs(Math.sin(t*1.5))})`;
  ctx.font='bold 20px monospace';ctx.textAlign='center';
  ctx.fillText("BARF'S HOUSE",PB.W/2,78);
  // Laugh track
  if(_pb.combo>2){
    for(let i=0;i<7;i++){
      const on=Math.sin(t*5+i)>0;
      ctx.fillStyle=on?'rgba(255,200,0,0.55)':'rgba(100,80,0,0.2)';
      ctx.beginPath();ctx.arc(95+i*43,66,5,0,Math.PI*2);ctx.fill();
    }
  }
}
function drawSDBg(ctx){
  const t=_pb.phaseTimer;
  const gr=ctx.createRadialGradient(PB.W/2,PB.H*0.25,10,PB.W/2,PB.H*0.25,220);
  gr.addColorStop(0,`rgba(0,65,140,${0.08+0.04*Math.sin(t*1.5)})`);
  gr.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=gr;ctx.fillRect(0,0,PB.W,PB.H);
  // Grime overlay
  const grime=(_pb.tableProgress.grime||0)/100;
  if(grime>0){ctx.fillStyle=`rgba(55,38,8,${grime*0.35})`;ctx.fillRect(0,0,PB.W,PB.H);}
  // Cleanliness
  ctx.fillStyle=`rgba(0,200,255,${0.35+0.1*Math.sin(t*2)})`;
  ctx.font='8px monospace';ctx.textAlign='left';
  ctx.fillText(`CLEAN: ${Math.round(100-(grime*100))}%`,50,28);
}

// ─── DMD (Dot Matrix Display) ─────────────────────────────────────────────────
function drawDMD(){
  if(!_dctx)return;
  const W=PB.W,H=96;
  _dctx.fillStyle='#040302';_dctx.fillRect(0,0,W,H);
  // Draw based on game phase
  if(_pb.phase==='attract') drawDMDAttract();
  else if(_pb.phase==='play'||_pb.phase==='plunge') drawDMDPlay();
  else if(_pb.phase==='lost') drawDMDLost();
  else if(_pb.phase==='gameover'||_pb.phase==='scores') drawDMDGameOver();
  // Scanlines
  _dctx.fillStyle='rgba(0,0,0,0.15)';
  for(let y=0;y<H;y+=2)_dctx.fillRect(0,y,W,1);
  // Border
  _dctx.strokeStyle='#2a2a2a';_dctx.lineWidth=2;_dctx.strokeRect(1,1,W-2,H-2);
}

function dmdText(text,x,y,size,color,ctx){
  const c=ctx||_dctx;
  c.fillStyle=color||'#ffaa14';
  c.font=`bold ${size}px monospace`;
  c.textAlign='center';
  c.textBaseline='middle';
  // Glow
  c.shadowColor=color||'#ffaa14';
  c.shadowBlur=size*0.6;
  c.fillText(text,x,y);
  c.shadowBlur=0;
}

function drawDMDAttract(){
  const t=_pb.phaseTimer;
  const ac=_tdef?.accentColor||'#ff8c14';
  const sc=_tdef?.secondColor||'#ff4400';
  const W=PB.W,H=96;
  // Pulsing background
  const pulse=0.4+0.3*Math.abs(Math.sin(t*1.2));
  _dctx.fillStyle=`rgba(${hexToRgb(ac)},${pulse*0.08})`;
  _dctx.fillRect(0,0,W,H);
  // Table name
  const nameSize=Math.min(22,Math.floor(W/(_tdef?.name?.length||8)*0.8));
  dmdText(_tdef?.name||'PINBALL BUDDY',W/2,30,nameSize,ac);
  dmdText(_tdef?.subtitle||'',W/2,60,9,sc);
  // Blinking start
  if(Math.sin(t*2.5)>0.2) dmdText('PRESS ANY BUTTON',W/2,80,8,'#ffdd00');
  if(_pb.highScores.length>0)
    dmdText('HI '+_pb.highScores[0].score.toLocaleString(),W/2,10,8,'#ff8800');
}

function drawDMDPlay(){
  const t=_pb.phaseTimer;
  const ac=_tdef?.accentColor||'#ff8c14';
  const W=PB.W,H=96;
  // Flash message if active
  if(_pb.dmdFlash>0){
    const pulse=0.5+0.5*Math.abs(Math.sin(t*7));
    _dctx.fillStyle=`rgba(${hexToRgb(ac)},${pulse*0.12})`;
    _dctx.fillRect(0,0,W,H);
    dmdText(_pb.dmdMsg,W/2,34,Math.min(20,Math.floor(W/(_pb.dmdMsg.length||8)*0.75)),`rgba(255,220,50,${0.7+pulse*0.3})`);
    if(_pb.dmdSub) dmdText(_pb.dmdSub,W/2,64,9,ac);
    dmdText(_pb.score.toLocaleString(),W/2,84,10,'#ffaa00');
    return;
  }
  // Normal play display
  dmdText(_pb.score.toLocaleString(),W/2,32,22,'#ffcc00');
  dmdText('BALL '+_pb.ballNum+'/3',W/2,62,10,ac);
  if(_pb.multiplier>1) dmdText(_pb.multiplier+'× MULTIPLIER',W/2,80,9,'#ff4400');
  else if(_pb.modeActive) dmdText(_pb.modeActive.toUpperCase(),W/2,80,9,'#ff0088');
  else dmdText(_tdef?.name||'',W/2,80,9,'rgba(255,140,20,0.4)');
  // Combo display top
  if(_pb.combo>2) dmdText('COMBO ×'+_pb.combo,W/2,12,8,'#ff8800');
}

function drawDMDLost(){
  const t=_pb.phaseTimer;
  const W=PB.W;
  for(let c=0;c<W;c+=4){
    const h=(c+t*80)%96;
    _dctx.fillStyle=`rgba(255,30,0,${0.08+0.04*Math.sin(c)})`;
    _dctx.fillRect(c,96-h,3,h);
  }
  dmdText('BALL LOST!',W/2,35,20,'#ff3300');
  dmdText(_pb.ballsLeft+' BALL'+(_pb.ballsLeft!==1?'S':'')+' REMAIN',W/2,65,10,'#ff8800');
  dmdText(_pb.score.toLocaleString(),W/2,82,9,'#ffaa00');
}

function drawDMDGameOver(){
  const t=_pb.phaseTimer;
  const W=PB.W;
  dmdText('GAME OVER',W/2,28,22,'#ff4400');
  dmdText(_pb.score.toLocaleString(),W/2,58,16,'#ffcc00');
  if(_pb.phase==='scores'){
    if(_pb.highScores.length) dmdText('HI: '+_pb.highScores[0].score.toLocaleString(),W/2,80,9,'#ff8800');
    if(Math.sin(t*2)>0) dmdText('PRESS TO PLAY AGAIN',W/2,90,7,'#888');
  }
}

// ─── AUDIO ────────────────────────────────────────────────────────────────────
function initAudio(){try{_ac=new(window.AudioContext||window.webkitAudioContext)();}catch(e){_ac=null;}}

function snd(name){
  if(!_ac)return;
  try{_ac.resume();}catch(e){}
  const ac=_ac,now=ac.currentTime;
  const g=ac.createGain();g.connect(ac.destination);
  switch(name){
    case 'flipper':{
      const o=ac.createOscillator();o.type='sawtooth';
      o.frequency.setValueAtTime(200,now);o.frequency.exponentialRampToValueAtTime(85,now+0.09);
      g.gain.setValueAtTime(0.2,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.11);
      o.connect(g);o.start(now);o.stop(now+0.12);break;
    }
    case 'bumper':{
      const o=ac.createOscillator(),o2=ac.createOscillator();
      o.type='square';o2.type='sine';
      o.frequency.setValueAtTime(450,now);o.frequency.exponentialRampToValueAtTime(220,now+0.13);
      o2.frequency.setValueAtTime(900,now);o2.frequency.exponentialRampToValueAtTime(450,now+0.09);
      g.gain.setValueAtTime(0.25,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.16);
      o.connect(g);o2.connect(g);o.start(now);o.stop(now+0.16);o2.start(now);o2.stop(now+0.12);break;
    }
    case 'target':{
      const o=ac.createOscillator();o.type='square';
      o.frequency.setValueAtTime(650,now);o.frequency.exponentialRampToValueAtTime(950,now+0.05);
      g.gain.setValueAtTime(0.15,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.12);
      o.connect(g);o.start(now);o.stop(now+0.12);break;
    }
    case 'wall':{
      const o=ac.createOscillator();o.type='sawtooth';o.frequency.value=100;
      g.gain.setValueAtTime(0.07,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.06);
      o.connect(g);o.start(now);o.stop(now+0.06);break;
    }
    case 'ramp':{
      [300,420,560,700].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='sine';o.frequency.value=f;
        og.gain.setValueAtTime(0,now+i*0.07);og.gain.linearRampToValueAtTime(0.15,now+i*0.07+0.05);
        og.gain.exponentialRampToValueAtTime(0.001,now+i*0.07+0.15);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.07);o.stop(now+i*0.07+0.18);
      });break;
    }
    case 'drain':{
      const o=ac.createOscillator();o.type='sawtooth';
      o.frequency.setValueAtTime(220,now);o.frequency.exponentialRampToValueAtTime(38,now+0.55);
      g.gain.setValueAtTime(0.32,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.6);
      o.connect(g);o.start(now);o.stop(now+0.62);break;
    }
    case 'launch':{
      const o=ac.createOscillator();o.type='sawtooth';
      o.frequency.setValueAtTime(70,now);o.frequency.exponentialRampToValueAtTime(420,now+0.22);
      g.gain.setValueAtTime(0.28,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.26);
      o.connect(g);o.start(now);o.stop(now+0.28);break;
    }
    case 'groupComplete':{
      [523,659,784,1047,1319].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='sine';o.frequency.value=f;
        og.gain.setValueAtTime(0.22,now+i*0.09);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.09+0.22);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.09);o.stop(now+i*0.09+0.25);
      });break;
    }
    case 'wormHole':{
      const o=ac.createOscillator();o.type='sawtooth';
      o.frequency.setValueAtTime(1400,now);o.frequency.exponentialRampToValueAtTime(60,now+0.45);
      g.gain.setValueAtTime(0.28,now);g.gain.exponentialRampToValueAtTime(0.001,now+0.5);
      o.connect(g);o.start(now);o.stop(now+0.5);break;
    }
    case 'wormHoleActivate':{
      for(let i=0;i<9;i++){
        const o=ac.createOscillator(),og=ac.createGain();o.type='sine';
        o.frequency.setValueAtTime(80+i*55,now+i*0.055);o.frequency.exponentialRampToValueAtTime(900,now+i*0.055+0.3);
        og.gain.setValueAtTime(0.12,now+i*0.055);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.055+0.38);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.055);o.stop(now+i*0.055+0.42);
      }break;
    }
    case 'multiball':{
      [280,380,500,650,800,1000].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='square';o.frequency.value=f;
        og.gain.setValueAtTime(0.14,now+i*0.06);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.06+0.18);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.06);o.stop(now+i*0.06+0.22);
      });break;
    }
    case 'modeStart':{
      [380,560,780,1040].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='sawtooth';o.frequency.value=f;
        og.gain.setValueAtTime(0.16,now+i*0.07);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.07+0.2);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.07);o.stop(now+i*0.07+0.22);
      });break;
    }
    case 'modeEnd':{
      [1040,780,560,380,220].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='sine';o.frequency.value=f;
        og.gain.setValueAtTime(0.16,now+i*0.08);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.08+0.22);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.08);o.stop(now+i*0.08+0.26);
      });break;
    }
    case 'gameOver':{
      [380,330,280,230,180,130].forEach((f,i)=>{
        const o=ac.createOscillator(),og=ac.createGain();o.type='sawtooth';o.frequency.value=f;
        og.gain.setValueAtTime(0.22,now+i*0.18);og.gain.exponentialRampToValueAtTime(0.001,now+i*0.18+0.28);
        o.connect(og);og.connect(ac.destination);o.start(now+i*0.18);o.stop(now+i*0.18+0.32);
      });break;
    }
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function lhn(hex,a){
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `#${[r,g,b].map(v=>Math.min(255,Math.round(v+(255-v)*a)).toString(16).padStart(2,'0')).join('')}`;
}
function dkn(hex,a){
  let r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `#${[r,g,b].map(v=>Math.max(0,Math.round(v*(1-a))).toString(16).padStart(2,'0')).join('')}`;
}
function hexToRgb(hex){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
function injectStyles(){
  if(document.getElementById('pbSt'))return;
  const s=document.createElement('style');s.id='pbSt';
  s.textContent=`
.pb-ov{position:fixed;inset:0;background:rgba(0,0,0,0.94);display:flex;align-items:center;justify-content:center;z-index:9000;backdrop-filter:blur(3px);}
.pb-shell{display:flex;flex-direction:column;align-items:center;position:relative;max-height:100dvh;overflow:hidden;}
.pb-dmd-bar{width:${PB.W}px;flex-shrink:0;background:#040302;border:2px solid #2a2a2a;border-bottom:none;border-radius:6px 6px 0 0;overflow:hidden;}
#pbDMD{display:block;}
.pb-field{flex-shrink:1;overflow:hidden;line-height:0;}
#pbCanvas{display:block;max-height:calc(100dvh - 96px - 52px);width:auto;}
.pb-btns{width:${PB.W}px;display:flex;gap:3px;background:#080808;border:2px solid #222;border-top:1px solid #2a2a2a;padding:5px 6px;box-sizing:border-box;flex-shrink:0;}
.pb-btn{font-family:monospace;font-weight:bold;font-size:13px;padding:9px 0;border:2px solid #333;border-radius:5px;background:#101010;color:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;}
.pb-btn:active,.pb-btn:focus{background:#282828;border-color:#888;outline:none;}
.pb-l{flex:3;text-align:left;padding-left:12px;}
.pb-r{flex:3;text-align:right;padding-right:12px;}
.pb-m{flex:1;font-size:10px;color:#777;text-align:center;}
.pb-x{position:fixed;top:8px;right:8px;width:34px;height:34px;border-radius:50%;border:1px solid #555;background:rgba(0,0,0,0.75);color:#aaa;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;z-index:9100;}
.pb-x:hover{border-color:#fff;color:#fff;}
`;
  document.head.appendChild(s);
}
