import * as RT from './realtime.js';

const canvas = document.getElementById('faceCanvas');
const ctx = canvas.getContext('2d');

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  orange:      '#F5890A',
  orangeDark:  '#D97500',
  black:       '#111111',
  eyeWhite:    '#EDF4FF',
  pupil:       '#111111',
  triHighlight:'#FFFFFF',
  mouthDark:   '#1E0008',
  tongue:      '#F0728A',
  tongueDark:  '#D4556A',
  teeth:       '#F9F9F9',
  teethLine:   '#D8D8D8',
};

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  mouthOpen:        0,
  blinkProgress:    0,
  blinkPhase:       'idle',
  autoBlinkEnabled: true,
  nextAutoBlink:    0,
  // Pupil look offset — -1 to 1 on each axis
  lookX:            0,
  lookY:            0,
  // Auto-look
  autoLookEnabled:  true,
  lookTargetX:      0,
  lookTargetY:      0,
  nextLookChange:   0,
  // Triangle highlight — tracks opposite side, switches under blink cover
  hlSide:           -1,     // -1 = left side of pupil, 1 = right side
  hlYFrac:          -0.75,  // smooth Y position on that side (-1..1, clamped away from extremes)
  hlPendingSide:    -1,     // desired side; applied at peak of blink
};

let mouthTarget    = 0;
let mouthAnimating = false;

// Audio-driven mouth (overrides slider while session is active)
let audioVolume    = 0;   // raw from analyser, 0–1
let audioMouthOpen = 0;   // smoothed value applied to state.mouthOpen

// ── Timer state ───────────────────────────────────────────────────────────────
const timer = {
  active:   false,
  paused:   false,
  startMs:  0,       // performance.now() of last start/resume
  elapsed:  0,       // accumulated seconds before current segment
  duration: 60,
  label:    '',
};

function getTimerElapsed() {
  if (!timer.active) return 0;
  if (timer.paused)  return timer.elapsed;
  return timer.elapsed + (performance.now() - timer.startMs) / 1000;
}

// ── DOM controls ─────────────────────────────────────────────────────────────
const mouthSlider       = document.getElementById('mouthSlider');
const openMouthBtn      = document.getElementById('openMouthBtn');
const closeMouthBtn     = document.getElementById('closeMouthBtn');
const blinkBtn          = document.getElementById('blinkBtn');
const autoBlinkCheckbox = document.getElementById('autoBlinkCheckbox');
const lookXSlider       = document.getElementById('lookXSlider');
const lookYSlider       = document.getElementById('lookYSlider');
const autoLookCheckbox  = document.getElementById('autoLookCheckbox');
const timerStartBtn     = document.getElementById('timerStartBtn');
const timerPauseBtn     = document.getElementById('timerPauseBtn');
const timerStopBtn      = document.getElementById('timerStopBtn');

mouthSlider.addEventListener('input', () => {
  state.mouthOpen = +mouthSlider.value;
  mouthAnimating  = false;
});
openMouthBtn.addEventListener('click', () => { mouthTarget = 1; mouthAnimating = true; });
closeMouthBtn.addEventListener('click', () => { mouthTarget = 0; mouthAnimating = true; });
blinkBtn.addEventListener('click', triggerBlink);
autoBlinkCheckbox.addEventListener('change', () => {
  state.autoBlinkEnabled = autoBlinkCheckbox.checked;
  if (state.autoBlinkEnabled) scheduleNextBlink();
});
lookXSlider.addEventListener('input', () => {
  state.lookX = +lookXSlider.value;
  state.autoLookEnabled = false;
  autoLookCheckbox.checked = false;
});
lookYSlider.addEventListener('input', () => {
  state.lookY = +lookYSlider.value;
  state.autoLookEnabled = false;
  autoLookCheckbox.checked = false;
});
autoLookCheckbox.addEventListener('change', () => {
  state.autoLookEnabled = autoLookCheckbox.checked;
  if (state.autoLookEnabled) scheduleNextLook();
});

timerStartBtn.addEventListener('click', () => startTimer(60));
timerPauseBtn.addEventListener('click', () => timer.paused ? resumeTimer() : pauseTimer());
timerStopBtn.addEventListener('click',  () => stopTimer());

// ── Fullscreen ────────────────────────────────────────────────────────────────
const fullscreenBtn = document.getElementById('fullscreenBtn');

fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    fullscreenBtn.textContent = '⛶';
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
});

// ── Sidebar toggle ────────────────────────────────────────────────────────────
const controlsWrap     = document.getElementById('controlsWrap');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');

toggleSidebarBtn.addEventListener('click', () => {
  const collapsed = controlsWrap.classList.toggle('collapsed');
  toggleSidebarBtn.textContent = collapsed ? '›' : '‹';
});

// ── Intro animation ───────────────────────────────────────────────────────────
const introOverlay = document.getElementById('introOverlay');
const introLogo    = document.getElementById('introLogo');
const introBtn     = document.getElementById('introBtn');

function playIntro() {
  introLogo.style.animation = 'none';
  introOverlay.classList.remove('hidden');
  void introLogo.offsetWidth;
  introLogo.style.animation = '';
  setTimeout(() => introOverlay.classList.add('hidden'), 5000);
}

introBtn.addEventListener('click', playIntro);

function triggerBlink() {
  if (state.blinkPhase === 'idle') state.blinkPhase = 'closing';
}

let pendingDoubleBlink = false;

function scheduleNextBlink() {
  state.nextAutoBlink = performance.now() + 1800 + Math.random() * 4200;
  pendingDoubleBlink  = false;
}

// ── Realtime session UI ───────────────────────────────────────────────────────
const apiModal       = document.getElementById('apiModal');
const apiKeyInput    = document.getElementById('apiKeyInput');
const voiceSelect    = document.getElementById('voiceSelect');
const systemPrompt   = document.getElementById('systemPrompt');
const modalConnectBtn= document.getElementById('modalConnectBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalError     = document.getElementById('modalError');
const sessionBadge   = document.getElementById('sessionBadge');
const badgeLabel     = document.getElementById('badgeLabel');
const badgeEndBtn    = document.getElementById('badgeEndBtn');

// Restore saved settings (system prompt falls back to the textarea's default HTML value)
apiKeyInput.value  = localStorage.getItem('openai_api_key') || '';
voiceSelect.value  = localStorage.getItem('openai_voice')   || 'coral';
const savedPrompt  = localStorage.getItem('openai_sys_prompt');
if (savedPrompt !== null) systemPrompt.value = savedPrompt;

function showModal() {
  modalError.classList.add('hidden');
  modalError.textContent = '';
  apiModal.classList.remove('hidden');
  apiKeyInput.focus();
}

function hideModal() {
  apiModal.classList.add('hidden');
}

function updateBadge(status) {
  if (status === 'idle') {
    sessionBadge.classList.add('hidden');
    sessionBadge.classList.remove('connecting');
  } else if (status === 'connecting') {
    sessionBadge.classList.remove('hidden');
    sessionBadge.classList.add('connecting');
    badgeLabel.textContent = 'Connecting…';
  } else if (status === 'active') {
    sessionBadge.classList.remove('hidden');
    sessionBadge.classList.remove('connecting');
    badgeLabel.textContent = 'Listening — click nose to stop';
  }
}

RT.setCallbacks({
  onStatusChange: updateBadge,
  onVolume: (vol) => { audioVolume = vol; },
  onFunctionCall: ({ name, args }) => {
    if (name === 'start_timer') {
      const secs  = Math.max(1, parseInt(args.seconds) || 60);
      const label = args.label || '';
      startTimer(secs, label);
      return { started: true, seconds: secs };
    }
    if (name === 'stop_timer') {
      const wasActive = timer.active;
      stopTimer();
      return { stopped: true, wasActive };
    }
    if (name === 'pause_timer') {
      if (!timer.active) return { error: 'No timer is running' };
      if (timer.paused) {
        resumeTimer();
        return { paused: false, message: 'Timer resumed' };
      } else {
        pauseTimer();
        return { paused: true, remaining: Math.ceil(timer.duration - getTimerElapsed()) };
      }
    }
    if (name === 'run_intro') {
      playIntro();
      return { playing: true };
    }
    return { error: 'unknown function' };
  },
});

modalConnectBtn.addEventListener('click', async () => {
  const key    = apiKeyInput.value.trim();
  const voice  = voiceSelect.value;
  const prompt = systemPrompt.value.trim();

  if (!key.startsWith('sk-')) {
    modalError.textContent = 'Key must start with "sk-"';
    modalError.classList.remove('hidden');
    return;
  }

  localStorage.setItem('openai_api_key',    key);
  localStorage.setItem('openai_voice',      voice);
  localStorage.setItem('openai_sys_prompt', prompt);

  hideModal();
  try {
    await RT.connect(key, { voice, systemPrompt: prompt });
  } catch (err) {
    modalError.textContent = err.message;
    modalError.classList.remove('hidden');
    showModal();
  }
});

modalCancelBtn.addEventListener('click', hideModal);

badgeEndBtn.addEventListener('click', () => RT.disconnect());

// Close modal on overlay click
apiModal.addEventListener('click', (e) => {
  if (e.target === apiModal) hideModal();
});

// Enter key in input
apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalConnectBtn.click();
});

// ── Nose hit-test + click ─────────────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;
  const g    = geom();
  const nr   = g.m * 0.028;
  const hit  = (nr * 3.5);       // generous hit radius
  const dx   = mx - g.cx;
  const dy   = my - g.cy;
  if (dx * dx + dy * dy <= hit * hit) {
    if (RT.status === 'idle') {
      showModal();
    } else {
      RT.disconnect();
    }
  }
});

function scheduleNextLook() {
  state.nextLookChange = performance.now() + 300 + Math.random() * 900;
}
scheduleNextLook();

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// ── Geometry (recomputed each frame from canvas size) ─────────────────────────
function geom() {
  const W  = canvas.width;
  const H  = canvas.height;
  const cx = W / 2;
  const cy = H / 2;

  // Perfect circle: radius is half the shorter dimension so it touches both edges
  const r = Math.min(W, H) / 2 - 4;
  const m = r * 2;   // diameter — base unit for all proportional sizes

  return {
    W, H, cx, cy, r, m,
    // Face is a perfect circle — same radius in both axes
    faceRx: r,
    faceRy: r,
    // Eye dimensions (scaled from circle diameter)
    eyeW:    m * 0.115,
    eyeH:    m * 0.30,
    eyeOffX: m * 0.19,
    eyeY:    cy + m * 0.04,
    // Mouth
    mouthCx: cx,
    mouthCy: cy + m * 0.195,
    mouthW:  m * 0.215,
    // Tick (fractions of face radius)
    tickOutR:     0.965,
    tickMinorInR: 0.880,
    tickMajorInR: 0.830,
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let lastT = 0;
scheduleNextBlink();

requestAnimationFrame(function loop(t) {
  const dt = Math.min(t - lastT, 50);
  lastT = t;
  update(dt, t);
  render();
  requestAnimationFrame(loop);
});

function update(dt, now) {
  // Animate mouth
  if (mouthAnimating) {
    const step = 0.0035 * dt;
    const diff = mouthTarget - state.mouthOpen;
    if (Math.abs(diff) <= step) {
      state.mouthOpen = mouthTarget;
      mouthAnimating  = false;
    } else {
      state.mouthOpen += Math.sign(diff) * step;
    }
    mouthSlider.value = state.mouthOpen;
  }

  // Blink animation  (~160ms close, ~130ms open)
  const closeSpeed = 0.011 * dt;
  const openSpeed  = 0.013 * dt;
  if (state.blinkPhase === 'closing') {
    state.blinkProgress += closeSpeed;
    if (state.blinkProgress >= 1) {
      state.blinkProgress = 1;
      state.blinkPhase = 'opening';
      // Apply any pending highlight side-switch while eyes are fully shut
      state.hlSide = state.hlPendingSide;
    }
  } else if (state.blinkPhase === 'opening') {
    state.blinkProgress -= openSpeed;
    if (state.blinkProgress <= 0) {
      state.blinkProgress = 0;
      state.blinkPhase    = 'idle';

      if (pendingDoubleBlink) {
        // Fire the second blink after a short pause (~80ms)
        pendingDoubleBlink = false;
        state.nextAutoBlink = now + 80;
      } else if (state.autoBlinkEnabled) {
        scheduleNextBlink();
      }
    }
  }

  // Auto-blink trigger
  if (state.autoBlinkEnabled && state.blinkPhase === 'idle' && now >= state.nextAutoBlink) {
    // ~25% chance of a double blink
    if (!pendingDoubleBlink && Math.random() < 0.25) {
      pendingDoubleBlink = true;
    }
    triggerBlink();
  }

  // ── Audio-driven mouth ────────────────────────────────────────────────────
  if (RT.status === 'active') {
    // Smooth the raw volume into a mouth open amount
    audioMouthOpen += (audioVolume - audioMouthOpen) * 0.18;
    state.mouthOpen  = audioMouthOpen;
    mouthSlider.value = state.mouthOpen;
    mouthAnimating    = false;
  }

  // ── Highlight side management ──────────────────────────────────────────────
  // Determine the desired side (OPPOSITE of look direction)
  if (Math.abs(state.lookX) > 0.18) {
    const wantSide = state.lookX > 0 ? -1 : 1;   // looking right → left side; looking left → right side
    if (wantSide !== state.hlSide && wantSide !== state.hlPendingSide) {
      state.hlPendingSide = wantSide;
      // Auto-trigger a blink so the switch is hidden
      if (state.blinkPhase === 'idle') triggerBlink();
    }
  }
  // Smooth Y: follow lookY, clamped to middle band (away from top/bottom)
  const maxHlY   = 0.78;
  const targetHlY = Math.max(-maxHlY, Math.min(maxHlY, -0.55 - state.lookY * 0.7));
  state.hlYFrac  += (targetHlY - state.hlYFrac) * 0.06;

  // Auto-look: smoothly drift pupils toward a random target
  if (state.autoLookEnabled) {
    if (now >= state.nextLookChange) {
      state.lookTargetX = (Math.random() * 2 - 1) * 1.0;
      state.lookTargetY = (Math.random() * 2 - 1) * 0.85;
      scheduleNextLook();
    }
    const ease = 0.025;
    state.lookX += (state.lookTargetX - state.lookX) * ease;
    state.lookY += (state.lookTargetY - state.lookY) * ease;
    lookXSlider.value = state.lookX;
    lookYSlider.value = state.lookY;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
// ── Timer helpers ─────────────────────────────────────────────────────────────
function startTimer(seconds = 60, label = '') {
  timer.active   = true;
  timer.paused   = false;
  timer.startMs  = performance.now();
  timer.elapsed  = 0;
  timer.duration = Math.max(1, seconds);
  timer.label    = label;
  updateTimerButtons();
}

function stopTimer() {
  timer.active = false;
  timer.paused = false;
  timer.elapsed = 0;
  updateTimerButtons();
}

function pauseTimer() {
  if (!timer.active || timer.paused) return;
  timer.elapsed += (performance.now() - timer.startMs) / 1000;
  timer.paused   = true;
  updateTimerButtons();
}

function resumeTimer() {
  if (!timer.active || !timer.paused) return;
  timer.startMs = performance.now();
  timer.paused  = false;
  updateTimerButtons();
}

function updateTimerButtons() {
  timerStartBtn.style.display = timer.active              ? 'none' : '';
  timerPauseBtn.style.display = timer.active              ? ''     : 'none';
  timerStopBtn.style.display  = timer.active              ? ''     : 'none';
  timerPauseBtn.textContent   = timer.paused ? '▶ Resume' : '⏸ Pause';
}

// ── Timer sweep hand ──────────────────────────────────────────────────────────
function drawTimerHand(g) {
  if (!timer.active) return;

  const elapsed   = getTimerElapsed();
  const progress  = Math.min(elapsed / timer.duration, 1);

  if (progress >= 1) {
    stopTimer();
    return;
  }

  const paused    = timer.paused;
  const handColor = paused ? '#D09000' : '#E02020';
  const arcColor  = paused ? 'rgba(200,140,0,0.18)' : 'rgba(220,30,30,0.18)';

  // Sweep from 12 o'clock clockwise
  const angle = progress * Math.PI * 2 - Math.PI / 2;
  const cos   = Math.cos(angle);
  const sin   = Math.sin(angle);

  const tipR  = g.r * 0.84;
  const tailR = g.r * 0.14;
  const lw    = g.m * 0.009;

  // Elapsed arc
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.r * 0.78, -Math.PI / 2, angle, false);
  ctx.strokeStyle = arcColor;
  ctx.lineWidth   = g.r * 0.09;
  ctx.lineCap     = 'butt';
  ctx.stroke();

  // Hand — black outline then coloured fill
  ctx.beginPath();
  ctx.moveTo(g.cx - cos * tailR, g.cy - sin * tailR);
  ctx.lineTo(g.cx + cos * tipR,  g.cy + sin * tipR);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth   = lw * 1.9;
  ctx.lineCap     = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(g.cx - cos * tailR, g.cy - sin * tailR);
  ctx.lineTo(g.cx + cos * tipR,  g.cy + sin * tipR);
  ctx.strokeStyle = handColor;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Pivot dot — black ring then coloured centre
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, lw * 3.0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(g.cx, g.cy, lw * 2.2, 0, Math.PI * 2);
  ctx.fillStyle = handColor;
  ctx.fill();

  // Countdown label
  const remaining = Math.ceil(timer.duration - elapsed);
  const prefix    = paused ? '⏸ ' : '';
  const suffix    = timer.label ? '  ' + timer.label : '';
  ctx.font         = `bold ${g.m * 0.055}px system-ui, sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = paused ? 'rgba(160,100,0,0.7)' : 'rgba(0,0,0,0.55)';
  ctx.fillText(prefix + remaining + 's' + suffix, g.cx, g.cy + g.r * 0.58);
}

function render() {
  const g = geom();
  ctx.clearRect(0, 0, g.W, g.H);
  drawFace(g);
  drawTicks(g);
  drawTimerHand(g);   // drawn on top of ticks, below facial features
  drawMouth(g);
  drawNose(g);
  drawEye(g, -1);   // left
  drawEye(g,  1);   // right
}

// ── Face body ─────────────────────────────────────────────────────────────────
function drawFace(g) {
  ctx.beginPath();
  ctx.ellipse(g.cx, g.cy, g.faceRx, g.faceRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.orange;
  ctx.fill();
}

// ── Clock tick marks ──────────────────────────────────────────────────────────
function drawTicks(g) {
  ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const angle  = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const cos    = Math.cos(angle);
    const sin    = Math.sin(angle);
    const major  = i % 3 === 0;
    const innerR = major ? g.tickMajorInR : g.tickMinorInR;

    ctx.beginPath();
    ctx.moveTo(g.cx + g.r * g.tickOutR * cos, g.cy + g.r * g.tickOutR * sin);
    ctx.lineTo(g.cx + g.r * innerR     * cos, g.cy + g.r * innerR     * sin);
    ctx.strokeStyle = C.black;
    ctx.lineWidth   = major ? g.m * 0.015 : g.m * 0.008;
    ctx.stroke();
  }
}

// ── Nose ─────────────────────────────────────────────────────────────────────
function drawNose(g) {
  const nr = g.m * 0.028;   // dot radius
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, nr, 0, Math.PI * 2);
  ctx.fillStyle = C.black;
  ctx.fill();
}

// Traces a flat-bottom eye shape: rounded dome on top, straight line on the bottom.
// The flat edge sits at y = ey (the eye's vertical center), the dome rises to ey - eh.
// Flat-bottom eye with rounded corners.
// Dome approximated with two cubic beziers (standard k=0.5523 ellipse fit).
// Bottom corners are rounded with arcTo so there are no sharp edges.
function eyeShapePath(ex, ey, ew, eh) {
  const cr = ew * 0.28;          // corner rounding radius
  const k  = 0.5523;             // bezier constant for quarter-ellipse

  ctx.beginPath();

  // Start at the very top of the dome
  ctx.moveTo(ex, ey - eh);

  // Right quarter of dome: top-center → just above right corner
  ctx.bezierCurveTo(
    ex + ew * k, ey - eh,        // cp1
    ex + ew,     ey - eh * k,    // cp2
    ex + ew,     ey - cr         // end: just above the right corner
  );

  // Round the right bottom corner
  ctx.arcTo(ex + ew, ey, ex + ew - cr, ey, cr);

  // Flat bottom line
  ctx.lineTo(ex - ew + cr, ey);

  // Round the left bottom corner
  ctx.arcTo(ex - ew, ey, ex - ew, ey - cr, cr);

  // Left quarter of dome: just above left corner → top-center
  ctx.bezierCurveTo(
    ex - ew,     ey - eh * k,    // cp1
    ex - ew * k, ey - eh,        // cp2
    ex,          ey - eh         // end: top-center
  );

  ctx.closePath();
}

// ── Eye (side: -1 = left, 1 = right) ─────────────────────────────────────────
function drawEye(g, side) {
  const ex  = g.cx + side * g.eyeOffX;
  const ey  = g.eyeY;
  const ew  = g.eyeW;
  const eh  = g.eyeH;
  const lw  = g.m * 0.011;
  const bp  = state.blinkProgress;

  // ---- White of eye ----
  eyeShapePath(ex, ey, ew, eh);
  ctx.fillStyle = C.eyeWhite;
  ctx.fill();

  // ---- Pupil — offset by look direction, clipped to eye shape ----
  const pw      = ew * 0.50;
  const ph      = eh * 0.46;
  const maxShiftX = ew * 0.42;
  const maxShiftY = eh * 0.32;
  const px = ex + state.lookX * maxShiftX;
  const py = ey + state.lookY * maxShiftY;

  ctx.save();
  eyeShapePath(ex, ey, ew, eh);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(px, py, pw, ph, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.pupil;
  ctx.fill();

  // ---- Triangle highlight ----
  // Sits on the pupil ellipse; apex always points exactly at the pupil center.
  const hs = state.hlSide;   // -1 = left side, 1 = right side
  const maxHlAngle = Math.PI * 0.38;   // ±68° — stays away from top/bottom poles

  // Parametric angle on the ellipse for this side + Y fraction
  const hlAngle = hs === 1
    ? state.hlYFrac * maxHlAngle            // right side: 0 = rightmost point
    : Math.PI - state.hlYFrac * maxHlAngle; // left side:  π = leftmost point

  // Point pushed outward beyond the pupil ellipse surface
  const edgePush = 1.35;
  const edgeX = px + pw * edgePush * Math.cos(hlAngle);
  const edgeY = py + ph * edgePush * Math.sin(hlAngle);

  // Unit vector from edge toward pupil center (apex direction)
  const dx   = px - edgeX;
  const dy   = py - edgeY;
  const dLen = Math.sqrt(dx * dx + dy * dy);
  const nX   = dx / dLen;
  const nY   = dy / dLen;
  const pX   = -nY;   // perpendicular (base axis)
  const pY   =  nX;

  const ts       = Math.min(pw, ph) * 1.3;
  const apexLen  = ts * 0.90;
  const halfBase = ts * 0.52;

  ctx.beginPath();
  ctx.moveTo(edgeX + nX * apexLen,  edgeY + nY * apexLen);   // apex → center
  ctx.lineTo(edgeX + pX * halfBase, edgeY + pY * halfBase);  // base vertex 1
  ctx.lineTo(edgeX - pX * halfBase, edgeY - pY * halfBase);  // base vertex 2
  ctx.closePath();
  ctx.fillStyle = C.eyeWhite;
  ctx.fill();
  ctx.restore();

  // ---- Orange eyelid (sweeps top → bottom, clipped to eye shape) ----
  if (bp > 0) {
    ctx.save();
    eyeShapePath(ex, ey, ew, eh);
    ctx.clip();

    const eyeTop = ey - eh;
    const lidH   = eh * bp;
    ctx.fillStyle = C.orange;
    ctx.fillRect(ex - ew - 2, eyeTop, ew * 2 + 4, lidH + 2);

    ctx.restore();
  }

  // ---- Eye outline (always on top of lid) ----
  eyeShapePath(ex, ey, ew, eh);
  ctx.strokeStyle = C.black;
  ctx.lineWidth   = lw;
  ctx.stroke();

  // ---- Eyelashes (3 per eye, follow the lid edge) ----
  drawEyelashes(g, side, ex, ey, ew, eh, bp, lw);
}

function drawEyelashes(g, side, ex, ey, ew, eh, bp, lw) {
  // 4 lashes evenly spaced, angled slightly inward toward the eye centre
  const xFracs = [-0.38, -0.13, 0.13, 0.38];
  const lashLen = eh * 0.18 * (1 - bp);

  ctx.strokeStyle = C.black;
  ctx.lineCap     = 'round';  // overridden per lash below

  xFracs.forEach(xf => {
    const lx = ex + xf * ew;

    const arcFrac = Math.sqrt(Math.max(0, 1 - xf * xf));
    const topY    = ey - eh * arcFrac;
    const botY    = ey;

    const rootY = topY + (botY - topY) * bp;

    // Lean toward face centre: all lashes on each eye point the same direction
    const inwardLean = -side * lashLen * 0.28;
    const tipX = lx + inwardLean;
    const tipY = rootY - lashLen;

    const cpX = lx + inwardLean * 0.5;
    const cpY = rootY - lashLen * 0.52;

    // Tapered filled lash — wide base, sharp point at tip
    const halfBase = lw * 0.65;
    // Perpendicular to the lash direction for the base width
    const dx  = tipX - lx;
    const dy  = tipY - rootY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const px  = (-dy / len) * halfBase;
    const py  = ( dx / len) * halfBase;

    ctx.beginPath();
    ctx.moveTo(lx + px, rootY + py);        // base left
    ctx.quadraticCurveTo(cpX + px, cpY + py, tipX, tipY);  // left edge → tip
    ctx.quadraticCurveTo(cpX - px, cpY - py, lx - px, rootY - py);  // tip → right edge
    ctx.closePath();
    ctx.fillStyle = C.black;
    ctx.fill();
  });
}

// ── Mouth ─────────────────────────────────────────────────────────────────────
function drawMouth(g) {
  const mx   = g.mouthCx;
  const my   = g.mouthCy;
  const mw   = g.mouthW;
  const open = state.mouthOpen;
  const lw   = g.m * 0.011;

  const halfW = mw * 0.46;
  const lx = mx - halfW;
  const rx = mx + halfW;

  // Top lip: a shallow smile that flattens progressively as the mouth opens
  const smileSag  = mw * 0.13 * (1 - open);   // how far the top lip dips at center
  const topMidY   = my + smileSag;             // control point for top lip curve

  // ---- Closed: just the smile arc ----
  if (open < 0.015) {
    ctx.beginPath();
    ctx.moveTo(lx, my);
    ctx.quadraticCurveTo(mx, topMidY, rx, my);
    ctx.strokeStyle = C.black;
    ctx.lineWidth   = lw * 1.6;
    ctx.lineCap     = 'round';
    ctx.stroke();
    return;
  }

  // ---- Open: mouth drops downward from the smile line ----
  const openH    = mw * 0.60 * open;
  const bottomY  = my + openH;
  const botSag   = openH * 0.12;              // slight outward curve on bottom lip

  // Reusable mouth shape path — U-shaped bottom
  function mouthPath() {
    ctx.beginPath();
    ctx.moveTo(lx, my);
    ctx.quadraticCurveTo(mx, topMidY, rx, my);   // top lip (flattening smile)
    // Right side straight down
    ctx.lineTo(rx, my + openH * 0.45);
    // U-shaped bottom: a smooth arc from right to left
    ctx.bezierCurveTo(
      rx, bottomY + openH * 0.15,                // cp1: pulls the right side down into the U
      lx, bottomY + openH * 0.15,                // cp2: pulls the left side down into the U
      lx, my + openH * 0.45                      // end: left side, same height as right
    );
    // Left side straight back up
    ctx.lineTo(lx, my);
    ctx.closePath();
  }

  // Dark interior fill
  ctx.save();
  mouthPath();
  ctx.fillStyle = C.mouthDark;
  ctx.fill();

  // Clip for teeth + tongue
  mouthPath();
  ctx.clip();

  // ---- Tongue ----
  const tongueAlpha = Math.min(1, Math.max(0, (open - 0.18) / 0.28));
  if (tongueAlpha > 0) {
    ctx.globalAlpha = tongueAlpha;
    const tw = halfW * 0.45;
    const th = openH * 0.32;
    const ty = bottomY - th * 0.3;

    ctx.beginPath();
    ctx.ellipse(mx, ty, tw, th, 0, 0, Math.PI * 2);
    ctx.fillStyle = C.tongue;
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  // ---- Top teeth — sit just below the top lip curve ----
  const teethAlpha = Math.min(1, Math.max(0, (open - 0.08) / 0.24));
  if (teethAlpha > 0) {
    ctx.globalAlpha = teethAlpha;

    const areaW    = halfW * 1.85;
    const toothH   = Math.min(openH * 0.36, mw * 0.10);
    const teethTop = my + smileSag;
    const teethL   = mx - areaW / 2;
    const teethR   = mx + areaW / 2;
    const r        = Math.min(areaW * 0.04, toothH * 0.28);

    ctx.beginPath();
    ctx.moveTo(teethL, teethTop);
    ctx.lineTo(teethR, teethTop);
    ctx.lineTo(teethR, teethTop + toothH - r);
    ctx.arcTo(teethR, teethTop + toothH, teethR - r, teethTop + toothH, r);
    ctx.lineTo(teethL + r, teethTop + toothH);
    ctx.arcTo(teethL, teethTop + toothH, teethL, teethTop + toothH - r, r);
    ctx.lineTo(teethL, teethTop);
    ctx.closePath();
    ctx.fillStyle = C.teeth;
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // Full mouth outline
  mouthPath();
  ctx.strokeStyle = C.black;
  ctx.lineWidth   = lw;
  ctx.stroke();

  // Top lip re-stroked thicker so the smile line stays prominent
  ctx.beginPath();
  ctx.moveTo(lx, my);
  ctx.quadraticCurveTo(mx, topMidY, rx, my);
  ctx.strokeStyle = C.black;
  ctx.lineWidth   = lw * 1.6;
  ctx.lineCap     = 'round';
  ctx.stroke();
}
