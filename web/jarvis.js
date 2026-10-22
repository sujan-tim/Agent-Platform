// The Jarvis tab: the same agent as Chat, behind a heads-up display with an
// arc reactor, in two modes. Prompt mode is typed; voice mode is spoken, with
// an optional "Hey Jarvis" wake word, follow-up questions without the wake
// word, and barge-in (talk over him and he stops).
//
// The look and the voice loop follow the Jarvis project
// (github.com/adewaskar/jarvis, MIT), rebuilt here without a build step, a 3D
// engine or its Claude Code bridge: every question goes through /api/chat, so
// the company's documents, tool rules and audit log apply exactly as in Chat.
//
// Speech uses the browser's own recognition and voices (Chrome or Edge).
// Everything shown is set with textContent, as in app.js.

import { markdownToSpeech, renderMarkdown } from './markdown.js';

const TAU = Math.PI * 2;

/** Colour per state, from Jarvis's phase colours. */
const PHASE_COLOR = {
  standby: '#12908f',
  waking: '#5cf2ef',
  listening: '#19d8d2',
  thinking: '#f0a93c',
  speaking: '#3ef2a8',
};

const PHASE_LABEL = {
  standby: 'Standing by',
  waking: 'Online',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

/** His name, with the spellings speech recognition often hears instead. */
const WAKE = /\b(?:hey|hi|ok|okay)?\s*(?:jarvis|jarvys|jervis|travis|jarviss|jarv)\b(?!'s)/i;
/** Ending on one of these means the sentence is probably not over. */
const CONTINUES =
  /\b(and|or|but|so|because|if|when|that|which|to|of|in|on|at|by|for|with|from|about|the|a|an|my|your|is|are|was|were|do|does|can|could|would|should|will)$/i;
const STAND_DOWN = /^(?:(?:hey\s+)?jarvis[,\s]*)?(?:stand down|stop listening|go to sleep|that's all|that is all|goodbye)[.!]?$/i;
/** How long he waits for a follow-up, without the wake word, after answering. */
const FOLLOW_UP_MS = 8000;

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountJarvis({ root, api, getConversationId, setConversationId }) {
  const $ = (selector) => root.querySelector(selector);
  const canvas = $('.jv-reactor');
  const reactor = createReactor(canvas);
  const speech = createSpeech();
  let mode = 'prompt';
  let phase = 'standby';
  let visible = false;
  let busy = false;

  // ── Shared: state, transcript, asking the agent ───────────────────────────

  function setPhase(next) {
    phase = next;
    reactor.setColor(PHASE_COLOR[next]);
    root.style.setProperty('--jv-accent', PHASE_COLOR[next]);
    $('.jv-phase').textContent = PHASE_LABEL[next];
  }

  function caption(text) {
    $('.jv-caption').textContent = text;
  }

  function addLine(who, text, meta) {
    const line = document.createElement('div');
    line.className = `jv-line jv-${who}`;
    const label = document.createElement('span');
    label.className = 'jv-who';
    label.textContent = who === 'user' ? 'You' : 'Jarvis';
    const body = document.createElement('div');
    body.className = 'jv-text';
    body.textContent = text;
    line.append(label, body);
    if (meta) {
      const small = document.createElement('small');
      small.textContent = meta;
      line.append(small);
    }
    $('.jv-log').append(line);
    line.scrollIntoView({ block: 'end' });
    return body;
  }

  /**
   * Reveals a reply a few characters at a time, like the HUD typing it out,
   * then swaps in the formatted version (lists, tables, cited sources).
   */
  function typeOut(el, text, sources) {
    const finish = () => el.replaceChildren(renderMarkdown(text, { sources }));
    if (reducedMotion || text.length > 1500) {
      finish();
      return;
    }
    const step = Math.max(2, Math.ceil(text.length / 120));
    let shown = 0;
    const tick = () => {
      shown = Math.min(text.length, shown + step);
      el.textContent = text.slice(0, shown);
      if (shown < text.length) setTimeout(tick, 16);
      else finish();
    };
    tick();
  }

  async function ask(question) {
    busy = true;
    setPhase('thinking');
    caption('');
    addLine('user', question);
    reactor.setLevelSource(() => 0.25 + 0.15 * Math.sin(performance.now() / 180));
    try {
      const result = await api('/api/chat', { method: 'POST', body: { message: question, conversationId: getConversationId() } });
      setConversationId(result.conversationId);
      const meta = result.toolsUsed.length ? `used: ${result.toolsUsed.join(', ')}` : '';
      typeOut(addLine('jarvis', '', meta), result.reply, result.sources);
      return result.reply;
    } catch (err) {
      addLine('jarvis', err.message, 'error');
      return null;
    } finally {
      busy = false;
      reactor.setLevelSource(null);
    }
  }

  // ── Prompt mode ───────────────────────────────────────────────────────────

  $('.jv-prompt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('.jv-input');
    const question = input.value.trim();
    if (!question || busy) return;
    input.value = '';
    const reply = await ask(question);
    if (reply && $('.jv-speak-replies').checked) {
      await say(reply);
    }
    setPhase('standby');
  });

  // ── Voice mode ────────────────────────────────────────────────────────────

  /**
   * One recogniser, kept running while voice mode is open, so he can hear
   * you while he talks. What a result means depends on `listen`:
   * 'wake' — only his name counts; 'command' — everything is the question;
   * 'guard' — he is busy, and speech that is not his own echo interrupts him.
   */
  let recognizer = null;
  let listen = 'off';
  let held = '';
  let sendTimer = null;
  let followUpTimer = null;
  let micStream = null;

  function setListen(next) {
    listen = next;
    clearTimeout(followUpTimer);
    if (next === 'wake' || next === 'off') {
      held = '';
      clearTimeout(sendTimer);
    }
    const wakeOn = $('.jv-wake').checked;
    const wantRecognizer = mode === 'voice' && visible && (next === 'command' || next === 'guard' || (next === 'wake' && wakeOn));
    if (wantRecognizer) startRecognizer();
    else stopRecognizer();
    if (next === 'wake' || next === 'off') {
      setPhase('standby');
      caption(wakeOn ? 'Say "Hey Jarvis", or press Space' : 'Press Space or tap the reactor to talk');
    }
  }

  function startRecognizer() {
    if (recognizer || !Recognition) return;
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        heard(result[0].transcript.trim(), result.isFinal);
      }
    };
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      const messages = {
        'not-allowed': 'Microphone blocked. Allow it in the address bar, then try again.',
        'service-not-allowed': 'Microphone blocked. Allow it in the address bar, then try again.',
        'audio-capture': 'No microphone found.',
        network: 'Speech recognition needs an internet connection.',
      };
      caption(messages[event.error] ?? `Voice input stopped: ${event.error}`);
      if (event.error in messages) {
        recognizer = null;
        listen = 'off';
      }
    };
    // Chrome ends continuous recognition every so often; keep it alive.
    rec.onend = () => {
      if (recognizer !== rec) return;
      recognizer = null;
      if (listen !== 'off') setTimeout(() => listen !== 'off' && startRecognizer(), 250);
    };
    recognizer = rec;
    try {
      rec.start();
    } catch {
      recognizer = null;
    }
  }

  function stopRecognizer() {
    const rec = recognizer;
    recognizer = null;
    if (rec) rec.abort();
  }

  function heard(text, isFinal) {
    if (!text) return;
    if (listen === 'wake') {
      const match = WAKE.exec(text);
      if (!match) return;
      const trailing = text.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, '');
      wake(trailing, isFinal);
      return;
    }
    if (listen === 'guard') {
      // Only while he speaks: real speech that is not his own voice coming back.
      if (phase !== 'speaking' || speech.isEcho(text) || text.split(/\s+/).length < 2) return;
      speech.stop();
      listen = 'command';
      setPhase('listening');
    }
    if (listen === 'command') {
      clearTimeout(followUpTimer);
      // "Hey Jarvis, what's…" arrives whole once it is final; the name is not part of the question.
      text = text.replace(new RegExp(`^${WAKE.source}[\\s,.:;!?-]*`, 'i'), '');
      if (!text) return;
      caption((held ? `${held} ` : '') + text);
      if (STAND_DOWN.test(text)) {
        standDown();
        return;
      }
      if (isFinal) {
        held = held ? `${held} ${text}` : text;
        // Send after a short pause, or a longer one if the sentence looks unfinished.
        clearTimeout(sendTimer);
        sendTimer = setTimeout(sendHeld, CONTINUES.test(held) ? 1600 : 700);
      } else {
        clearTimeout(sendTimer);
      }
    }
  }

  function wake(trailing = '', isFinal = false) {
    if (mode !== 'voice') return;
    speech.unlock();
    setPhase('waking');
    setTimeout(() => phase === 'waking' && setPhase('listening'), 350);
    held = '';
    setListen('command');
    startMicLevel();
    caption(trailing || 'Listening…');
    if (trailing && isFinal) heard(trailing, true);
    followUpTimer = setTimeout(() => !held && listen === 'command' && setListen('wake'), FOLLOW_UP_MS);
  }

  async function sendHeld() {
    const question = held.trim();
    held = '';
    if (!question || busy) return;
    setListen('guard');
    const reply = await ask(question);
    if (mode !== 'voice' || !visible) return;
    if (reply) {
      setPhase('speaking');
      await say(reply);
    }
    if (mode !== 'voice' || !visible || listen !== 'guard') return;
    // Answered: listen for a follow-up without the wake word, for a while.
    setPhase('listening');
    caption('Anything else?');
    setListen('command');
    followUpTimer = setTimeout(() => !held && listen === 'command' && setListen('wake'), FOLLOW_UP_MS);
  }

  async function say(text) {
    setPhase('speaking');
    reactor.setLevelSource(() => speech.level());
    await speech.speak(markdownToSpeech(text));
    reactor.setLevelSource(micStream ? micLevel : null);
  }

  function standDown() {
    speech.stop();
    setListen('wake');
  }

  // The reactor's pulse follows your voice while he listens.
  let analyser = null;
  const samples = new Uint8Array(512);
  function micLevel() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / samples.length) * 4);
  }

  async function startMicLevel() {
    if (micStream || !navigator.mediaDevices?.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(micStream).connect(analyser);
      micStream.context = context;
      if (phase === 'listening') reactor.setLevelSource(micLevel);
    } catch {
      // Recognition still works without the meter.
    }
  }

  function stopMicLevel() {
    if (!micStream) return;
    for (const track of micStream.getTracks()) track.stop();
    micStream.context?.close();
    micStream = null;
    analyser = null;
  }

  function talkOrStop() {
    if (mode !== 'voice') return;
    if (phase === 'speaking') {
      speech.stop();
      wake();
    } else if (listen === 'command') {
      if (held) sendHeld();
      else standDown();
    } else if (!busy) {
      wake();
    }
  }

  canvas.addEventListener('click', talkOrStop);
  $('.jv-talk').addEventListener('click', talkOrStop);
  $('.jv-wake').addEventListener('change', () => listen === 'wake' && setListen('wake'));
  $('.jv-voice-name').addEventListener('click', () => {
    $('.jv-voice-name').textContent = `Voice: ${speech.nextVoice()}`;
  });

  document.addEventListener('keydown', (e) => {
    if (!visible || e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space' && mode === 'voice') {
      e.preventDefault();
      talkOrStop();
    } else if (e.key === 'Escape' && mode === 'voice') {
      standDown();
    }
  });

  // ── Modes and visibility ──────────────────────────────────────────────────

  function setMode(next) {
    mode = next;
    for (const button of root.querySelectorAll('.jv-mode')) {
      button.classList.toggle('active', button.dataset.mode === next);
      button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    }
    root.classList.toggle('jv-voice-mode', next === 'voice');
    $('.jv-prompt-form').hidden = next !== 'prompt';
    $('.jv-voice-controls').hidden = next !== 'voice';
    speech.stop();
    if (next === 'voice') {
      if (!Recognition) {
        caption('Voice mode needs Chrome or Edge. Prompt mode works in any browser.');
        return;
      }
      $('.jv-voice-name').textContent = `Voice: ${speech.voiceName()}`;
      setListen('wake');
    } else {
      setListen('off');
      stopMicLevel();
      caption('Type a command below');
      $('.jv-input').focus();
    }
  }

  for (const button of root.querySelectorAll('.jv-mode')) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }

  setPhase('standby');
  setMode('prompt');

  return {
    show(companyName) {
      visible = true;
      $('.jv-company').textContent = companyName;
      reactor.start();
      root.classList.remove('jv-booted');
      // Restarts the short power-up animation each time the tab opens.
      void root.offsetWidth;
      root.classList.add('jv-booted');
      if (mode === 'voice') setListen('wake');
    },
    hide() {
      visible = false;
      speech.stop();
      setListen('off');
      stopMicLevel();
      reactor.stop();
    },
  };
}

// ── The arc reactor (2D canvas) ─────────────────────────────────────────────

function createReactor(canvas) {
  const ctx = canvas.getContext('2d');
  let frame = 0;
  let color = hexToRgb(PHASE_COLOR.standby);
  let target = color;
  let level = 0;
  let levelSource = null;
  const dust = Array.from({ length: 700 }, () => ({
    a: Math.random() * TAU,
    r: gaussian() * 0.075,
    speed: (Math.random() - 0.5) * 0.0016,
    size: Math.random() < 0.85 ? 1 : 2,
    flicker: Math.random() * TAU,
  }));

  function resize() {
    const size = canvas.clientWidth;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * scale)) {
      canvas.width = canvas.height = Math.round(size * scale);
    }
  }

  /** Smooth, angle-periodic wobble: whole-number frequencies keep the ring closed. */
  function wobble(a, t) {
    return (
      0.014 * Math.sin(3 * a + t * 0.21) +
      0.008 * Math.sin(5 * a - t * 0.33 + 1.3) +
      0.004 * Math.sin(11 * a + t * 0.5 + 0.4) +
      0.002 * Math.sin(19 * a - t * 0.8)
    );
  }

  function draw(now) {
    frame = requestAnimationFrame(draw);
    resize();
    const t = reducedMotion ? 0 : now / 1000;
    const W = canvas.width;
    const c = W / 2;
    const R = W * 0.36;
    color = color.map((v, i) => v + (target[i] - v) * 0.06);
    const wanted = levelSource ? Math.max(0, Math.min(1, levelSource())) : 0;
    level += (wanted - level) * (wanted > level ? 0.35 : 0.08);
    const rgba = (alpha) => `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha})`;

    ctx.clearRect(0, 0, W, W);
    ctx.globalCompositeOperation = 'lighter';

    // Glow behind everything.
    const glow = ctx.createRadialGradient(c, c, 0, c, c, R * 1.5);
    glow.addColorStop(0, rgba(0.16 + level * 0.12));
    glow.addColorStop(0.55, rgba(0.05));
    glow.addColorStop(1, rgba(0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, W);

    // Fine concentric hairlines inside the disc.
    ctx.lineWidth = Math.max(1, W / 900);
    for (let i = 1; i <= 7; i++) {
      ctx.strokeStyle = rgba(0.05 + (i % 3 === 0 ? 0.05 : 0));
      ctx.beginPath();
      ctx.arc(c, c, R * (0.12 * i), 0, TAU);
      ctx.stroke();
    }

    // Rotating tick ring.
    const ticks = 120;
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * TAU + t * 0.05;
      const long = i % 10 === 0;
      const r0 = R * 0.86;
      const r1 = R * (long ? 0.8 : 0.83);
      ctx.strokeStyle = rgba(long ? 0.5 : 0.22);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      ctx.stroke();
    }

    // Three counter-rotating arc segments.
    ctx.lineWidth = W / 220;
    for (let i = 0; i < 3; i++) {
      const start = (i / 3) * TAU - t * 0.18;
      ctx.strokeStyle = rgba(0.38);
      ctx.beginPath();
      ctx.arc(c, c, R * 0.64, start, start + TAU / 5);
      ctx.stroke();
    }

    // Voice ring: ripples with the level while he listens or speaks.
    ctx.lineWidth = W / 400;
    ctx.strokeStyle = rgba(0.35 + level * 0.5);
    ctx.beginPath();
    for (let i = 0; i <= 180; i++) {
      const a = (i / 180) * TAU;
      const r = R * (0.46 + level * 0.07 * Math.sin(6 * a + t * 7) * Math.sin(3 * a - t * 3));
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // The main ring: a soft, breathing band.
    ctx.lineWidth = W / 95;
    ctx.shadowColor = rgba(0.9);
    ctx.shadowBlur = W / 22;
    ctx.strokeStyle = rgba(0.55 + level * 0.3);
    ctx.beginPath();
    for (let i = 0; i <= 240; i++) {
      const a = (i / 240) * TAU;
      const r = R * (1 + wobble(a, t) + level * 0.035);
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dust on the ring's edge, which makes it look eroded rather than drawn.
    for (const d of dust) {
      d.a += d.speed * (1 + level * 3);
      const r = R * (1 + wobble(d.a, t) + d.r * (1 + level));
      const alpha = 0.25 + 0.35 * Math.sin(d.flicker + t * 2) ** 2;
      ctx.fillStyle = rgba(alpha);
      ctx.fillRect(c + Math.cos(d.a) * r, c + Math.sin(d.a) * r, d.size * (W / 600), d.size * (W / 600));
    }

    // The core.
    const coreR = R * (0.16 + level * 0.07);
    const core = ctx.createRadialGradient(c, c, 0, c, c, coreR);
    core.addColorStop(0, 'rgba(255,255,255,0.9)');
    core.addColorStop(0.3, rgba(0.8));
    core.addColorStop(1, rgba(0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(c, c, coreR, 0, TAU);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    start() {
      if (!frame) frame = requestAnimationFrame(draw);
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
    setColor(hex) {
      target = hexToRgb(hex);
    },
    /** A function returning 0..1, read every frame; null for still. */
    setLevelSource(fn) {
      levelSource = fn;
    },
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function gaussian() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

// ── Speaking (the browser's own voices) ─────────────────────────────────────

function createSpeech() {
  const supported = 'speechSynthesis' in window;
  let voice = null;
  let spoken = '';
  let pulse = 0;
  let generation = 0;
  let voiceIndex = 0;

  /** Ranks voices by closeness to the character: a British male (from Jarvis's tts.ts). */
  function score(v) {
    const n = v.name.toLowerCase();
    let s = 0;
    if (n.startsWith('daniel')) s += 100;
    else if (n.includes('google uk english male')) s += 85;
    else if (/\b(oliver|arthur|jamie|malcolm)\b/.test(n)) s += 80;
    else if (/\b(reed|rocko|eddy)\b/.test(n)) s += 40;
    if (n.includes('premium')) s += 30;
    else if (n.includes('enhanced')) s += 20;
    if (/en[-_]gb/i.test(v.lang)) s += 25;
    else if (/^en/i.test(v.lang)) s += 5;
    if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) s -= 200;
    if (/\b(flo|sandy|shelley|kate|serena|fiona|moira|karen|tessa|samantha|zoe|allison|ava|susan)\b/.test(n)) s -= 60;
    return s;
  }

  function candidates() {
    if (!supported) return [];
    const english = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    return english.sort((a, b) => score(b) - score(a));
  }

  function pick() {
    if (voice) return voice;
    const list = candidates();
    let saved = null;
    try {
      saved = localStorage.getItem('jarvis.voice');
    } catch {
      // Storage blocked: use the best match.
    }
    voice = list.find((v) => v.name === saved) ?? list[0] ?? null;
    return voice;
  }

  if (supported) speechSynthesis.addEventListener('voiceschanged', () => (voice = null));

  /** Splits a reply into sentences: Chrome cuts off long utterances. */
  function sentences(text) {
    const plain = text.replace(/[*_#`>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();
    return plain.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  }

  const words = (text) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);

  return {
    /** Speaks `text`; resolves when done or stopped. */
    speak(text) {
      if (!supported) return Promise.resolve();
      const mine = ++generation;
      spoken = text;
      speechSynthesis.cancel();
      // Chrome can stay paused after a cancel; this un-sticks it.
      speechSynthesis.resume();
      const parts = sentences(text);
      return new Promise((resolve) => {
        const next = (i) => {
          if (mine !== generation || i >= parts.length) {
            pulse = 0;
            resolve();
            return;
          }
          const u = new SpeechSynthesisUtterance(parts[i]);
          const v = pick();
          if (v) u.voice = v;
          u.lang = v?.lang ?? 'en-GB';
          u.rate = 1.02;
          u.onboundary = () => (pulse = 1);
          u.onend = () => next(i + 1);
          u.onerror = () => next(i + 1);
          speechSynthesis.speak(u);
        };
        next(0);
      });
    },
    stop() {
      generation++;
      pulse = 0;
      if (supported) speechSynthesis.cancel();
    },
    /** Must run inside a click or key press once, or some browsers stay silent. */
    unlock() {
      if (supported) speechSynthesis.resume();
    },
    /** 0..1 for the reactor: speech exposes no loudness, so each word is a pulse. */
    level() {
      pulse *= 0.9;
      return 0.35 + pulse * 0.55 + 0.08 * Math.sin(performance.now() / 90);
    },
    /** True if `heard` is mostly his own words coming back through the speakers. */
    isEcho(heard) {
      const said = words(spoken);
      const got = [...words(heard)];
      if (got.length === 0) return true;
      return got.filter((w) => said.has(w)).length / got.length >= 0.6;
    },
    voiceName() {
      return pick()?.name ?? 'browser default';
    },
    nextVoice() {
      const list = candidates();
      if (list.length === 0) return 'browser default';
      voiceIndex = (list.indexOf(pick()) + 1) % list.length;
      voice = list[voiceIndex];
      try {
        localStorage.setItem('jarvis.voice', voice.name);
      } catch {
        // Not remembered; still used for this visit.
      }
      return voice.name;
    },
  };
}
