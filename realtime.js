// ── OpenAI Realtime API connection ───────────────────────────────────────────
// Direct WebSocket to wss://api.openai.com/v1/realtime
// Audio in:  AudioWorklet → PCM16 base64 → input_audio_buffer.append
// Audio out: response.audio.delta chunks → WAV → Web Audio analyser → volume

const MODEL       = 'gpt-4o-realtime-preview-2024-12-17';
const SAMPLE_RATE = 24000;

// AudioWorklet mic processor source (loaded as a blob to stay self-contained)
const WORKLET_CODE = `
class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch);
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
`;

// ── Public state ─────────────────────────────────────────────────────────────
export let status = 'idle';   // 'idle' | 'connecting' | 'active'

let _onStatusChange = null;
let _onVolume       = null;
let _onFunctionCall = null;  // ({ name, args }) => resultObject

/** Register callbacks: { onStatusChange(status), onVolume(0–1), onFunctionCall({name,args}) } */
export function setCallbacks({ onStatusChange, onVolume, onFunctionCall } = {}) {
  _onStatusChange = onStatusChange ?? null;
  _onVolume       = onVolume       ?? null;
  _onFunctionCall = onFunctionCall ?? null;
}

// ── Tool definition ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    type:        'function',
    name:        'start_timer',
    description: 'Starts a countdown timer that displays a sweeping hand on the clock face. Use this whenever the user asks to set or start a timer.',
    parameters: {
      type:       'object',
      properties: {
        seconds: {
          type:        'integer',
          description: 'Duration of the timer in seconds',
          minimum:     1,
          maximum:     3600,
        },
        label: {
          type:        'string',
          description: 'Optional short label shown on the clock (e.g. "Move!" or "Think")',
        },
      },
      required: ['seconds'],
    },
  },
  {
    type:        'function',
    name:        'stop_timer',
    description: 'Stops and clears the current countdown timer completely.',
    parameters:  { type: 'object', properties: {}, required: [] },
  },
  {
    type:        'function',
    name:        'pause_timer',
    description: 'Pauses the timer if it is running, or resumes it if it is already paused.',
    parameters:  { type: 'object', properties: {}, required: [] },
  },
  {
    type:        'function',
    name:        'run_intro',
    description: 'Plays the intro animation — a spinning logo on a green background for 5 seconds. Use this to make a dramatic entrance or celebrate something.',
    parameters:  { type: 'object', properties: {}, required: [] },
  },
];

// ── Private ───────────────────────────────────────────────────────────────────
let ws           = null;
let localStream  = null;
let micCtx       = null;
let micNode      = null;    // AudioWorkletNode
let micSource    = null;
let workletUrl   = null;
let playCtx      = null;
let analyser     = null;
let volData      = null;
let playAudio    = null;
let playUrl      = null;
let audioChunks    = [];
let smoothVol      = 0;
let volRafId       = null;
let pendingCalls   = {};   // call_id → { name, argStr }

function setStatus(s) {
  status = s;
  _onStatusChange?.(s);
}

// ── PCM16 helpers ─────────────────────────────────────────────────────────────
function float32ToPCM16Base64(f32) {
  const buf  = new ArrayBuffer(f32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin   = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function buildWav(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf   = new ArrayBuffer(44 + total);
  const v     = new DataView(buf);
  const str   = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + total, true);
  str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total, true);
  const out = new Uint8Array(buf);
  let off = 44;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new Blob([buf], { type: 'audio/wav' });
}

// ── Microphone capture (AudioWorklet) ─────────────────────────────────────────
async function setupMic(stream) {
  micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Load worklet from blob URL so we need no extra server file
  const blob   = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  workletUrl   = URL.createObjectURL(blob);
  await micCtx.audioWorklet.addModule(workletUrl);

  micSource = micCtx.createMediaStreamSource(stream);
  micNode   = new AudioWorkletNode(micCtx, 'mic-processor');

  micNode.port.onmessage = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type:  'input_audio_buffer.append',
      audio: float32ToPCM16Base64(e.data),
    }));
  };

  micSource.connect(micNode);
  // Don't connect micNode to destination — we don't want to hear ourselves
}

function teardownMic() {
  try { micNode?.disconnect();   } catch {}
  try { micSource?.disconnect(); } catch {}
  try { micCtx?.close();         } catch {}
  if (workletUrl) { URL.revokeObjectURL(workletUrl); workletUrl = null; }
  micNode = micSource = micCtx = null;
}

// ── Playback + volume analysis ────────────────────────────────────────────────
function stopVolLoop() {
  if (volRafId) { cancelAnimationFrame(volRafId); volRafId = null; }
}

function startVolLoop() {
  stopVolLoop();
  const tick = () => {
    if (!analyser || !playAudio || playAudio.paused) {
      smoothVol += (0 - smoothVol) * 0.15;
      _onVolume?.(smoothVol);
      return;
    }
    analyser.getFloatTimeDomainData(volData);
    let rms = 0;
    for (const s of volData) rms += s * s;
    rms = Math.sqrt(rms / volData.length);

    const raw = Math.min(1, rms * 10);
    smoothVol += (raw - smoothVol) * 0.25;
    _onVolume?.(smoothVol);
    volRafId = requestAnimationFrame(tick);
  };
  volRafId = requestAnimationFrame(tick);
}

async function playChunks(chunks) {
  stopVolLoop();
  try { playAudio?.pause(); } catch {}
  try { playCtx?.close();   } catch {}
  if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = null; }

  const blob  = buildWav(chunks);
  playUrl     = URL.createObjectURL(blob);
  playAudio   = new Audio(playUrl);

  playCtx  = new AudioContext();
  analyser = playCtx.createAnalyser();
  analyser.fftSize = 256;
  volData  = new Float32Array(analyser.fftSize);

  const src = playCtx.createMediaElementSource(playAudio);
  src.connect(analyser);
  analyser.connect(playCtx.destination);

  playAudio.onplay  = () => startVolLoop();
  playAudio.onpause = () => { stopVolLoop(); _onVolume?.(0); };
  playAudio.onended = () => {
    stopVolLoop();
    smoothVol = 0;
    _onVolume?.(0);
    URL.revokeObjectURL(playUrl);
    playUrl = null; playAudio = null;
    try { playCtx?.close(); } catch {}
    playCtx = null; analyser = null; volData = null;
  };

  try {
    await playCtx.resume();
    await playAudio.play();
  } catch (err) {
    console.warn('[Realtime] Playback error:', err);
  }
}

// ── WebSocket message handler ─────────────────────────────────────────────────
function handleMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  switch (msg.type) {
    case 'session.created':
    case 'session.updated':
      console.log('[Realtime]', msg.type);
      break;

    // ── Audio out ──────────────────────────────────────────────────────────
    case 'response.audio.delta':
    case 'response.output_audio.delta':
      audioChunks.push(base64ToUint8(msg.delta));
      break;

    case 'response.audio.done':
    case 'response.output_audio.done':
      if (audioChunks.length > 0) {
        playChunks([...audioChunks]);
        audioChunks = [];
      }
      break;

    // ── Function calling ───────────────────────────────────────────────────
    case 'response.output_item.added':
      if (msg.item?.type === 'function_call') {
        pendingCalls[msg.item.call_id] = { name: msg.item.name, argStr: '' };
      }
      break;

    case 'response.function_call_arguments.delta':
      if (pendingCalls[msg.call_id] !== undefined) {
        pendingCalls[msg.call_id].argStr += msg.delta;
      }
      break;

    case 'response.function_call_arguments.done': {
      const call = pendingCalls[msg.call_id];
      if (call) {
        delete pendingCalls[msg.call_id];
        let args = {};
        try { args = JSON.parse(call.argStr || '{}'); } catch {}
        console.log('[Realtime] Function call:', call.name, args);

        let result = { error: 'no handler' };
        if (_onFunctionCall) {
          try { result = _onFunctionCall({ name: call.name, args }) ?? {}; } catch {}
        }

        // Send result back so the model can speak the confirmation
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type:    'function_call_output',
            call_id: msg.call_id,
            output:  JSON.stringify(result),
          },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      }
      break;
    }

    case 'error':
      console.error('[Realtime] API error:', msg.error?.message ?? msg.error);
      break;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * @param {string} apiKey  - OpenAI API key (sk-...)
 * @param {object} opts
 * @param {string} opts.voice        - 'alloy' | 'echo' | 'shimmer' | 'ash' | 'coral' | 'sage' | 'verse'
 * @param {string} opts.systemPrompt - Instructions for the assistant
 */
export async function connect(apiKey, { voice = 'coral', systemPrompt = "You are Tempo, a cheerful chess timer who has learned all the secrets of chess by watching countless games tick by. You love teaching chess — openings, tactics, strategy, all of it — with wit, warmth, and the occasional clock pun. Keep answers short, fun, and encouraging. If someone seems confused, be patient and playful. You live for the game!" } = {}) {
  if (status !== 'idle') return;
  setStatus('connecting');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    setStatus('idle');
    throw new Error('Microphone access denied: ' + err.message);
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${apiKey}`]);

  ws.onopen = async () => {
    // Full session config required for audio to flow both ways
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type:         'realtime',
        instructions: systemPrompt,
        audio: {
          output: {
            voice: voice,
          },
        },
        tools: TOOLS,
      },
    }));

    await setupMic(localStream);
    setStatus('active');
  };

  ws.onmessage = handleMessage;
  ws.onerror   = (e) => { console.error('[Realtime] WS error', e); disconnect(); };
  ws.onclose   = ()  => { if (status !== 'idle') disconnect(); };
}

export function disconnect() {
  setStatus('idle');
  stopVolLoop();
  smoothVol = 0;
  _onVolume?.(0);

  try { ws?.close(); }          catch {}
  ws = null;

  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  teardownMic();

  try { playAudio?.pause(); }   catch {}
  try { playCtx?.close(); }     catch {}
  playAudio = null; playCtx = null; analyser = null; volData = null;

  if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = null; }
  audioChunks  = [];
  pendingCalls = {};
}
