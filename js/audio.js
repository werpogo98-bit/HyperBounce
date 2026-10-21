/* ============================================================
 * Ricochet Frenzy — audio.js
 * Procedural Web Audio API SFX with ascending pitch on rapid
 * combos, plus optional external mp3 overrides in assets/sfx/.
 * Namespace: RF.Audio
 * ============================================================ */
(function (global) {
  'use strict';

  const ExternalSfx = {
    // Drop real .mp3 files into assets/sfx/ with these names to override.
    shoot:   'assets/sfx/shoot.mp3',
    bounce:  'assets/sfx/bounce.mp3',
    hit:     'assets/sfx/hit.mp3',
    destroy: 'assets/sfx/destroy.mp3',
    gate:    'assets/sfx/gate.mp3',
    merge:   'assets/sfx/merge.mp3',
    wave:    'assets/sfx/wave.mp3',
    buy:     'assets/sfx/buy.mp3',
    gameover:'assets/sfx/gameover.mp3'
  };

  const AudioSys = {
    ctx: null,
    master: null,
    enabled: true,
    _external: {},          // name -> {url, buffer|null, failed}
    _lastHitT: 0,
    _comboStep: 0
  };

  AudioSys.init = function () {
    if (AudioSys.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { AudioSys.enabled = false; return; }
    try {
      AudioSys.ctx = new AC();
      AudioSys.master = AudioSys.ctx.createGain();
      AudioSys.master.gain.value = 0.5;
      AudioSys.master.connect(AudioSys.ctx.destination);
    } catch (e) { AudioSys.enabled = false; return; }

    // Kick off async loads for any provided mp3s (fail silently → procedural).
    Object.keys(ExternalSfx).forEach(function (name) {
      AudioSys._external[name] = { url: ExternalSfx[name], buffer: null, failed: false, loading: false };
    });
  };

  /** Resume context after a user gesture (Telegram/browser autoplay policy). */
  AudioSys.unlock = function () {
    if (AudioSys.ctx && AudioSys.ctx.state === 'suspended') {
      AudioSys.ctx.resume().catch(function () {});
    }
  };

  AudioSys.loadExternal = function (name) {
    const slot = AudioSys._external[name];
    if (!slot || slot.loading || slot.buffer || slot.failed) return;
    slot.loading = true;
    fetch(slot.url)
      .then(function (r) { if (!r.ok) throw new Error('404'); return r.arrayBuffer(); })
      .then(function (ab) { return AudioSys.ctx.decodeAudioData(ab); })
      .then(function (buf) { slot.buffer = buf; slot.loading = false; })
      .catch(function () { slot.failed = true; slot.loading = false; });
  };

  function playExternal(name, detuneSemis) {
    const slot = AudioSys._external[name];
    if (!slot) return false;
    if (!slot.buffer && !slot.failed) AudioSys.loadExternal(name);
    if (!slot.buffer) return false;
    const ctx = AudioSys.ctx;
    const src = ctx.createBufferSource();
    src.buffer = slot.buffer;
    if (detuneSemis) src.playbackRate.value = Math.pow(2, detuneSemis / 12);
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g); g.connect(AudioSys.master);
    src.start();
    return true;
  }

  /* ---------------- primitives ---------------- */

  function tone(opts) {
    const ctx = AudioSys.ctx;
    const t0 = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + opts.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.vol != null ? opts.vol : 0.25, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g); g.connect(AudioSys.master);
    osc.start(t0); osc.stop(t0 + opts.dur + 0.02);
  }

  function noise(opts) {
    const ctx = AudioSys.ctx;
    const t0 = ctx.currentTime + (opts.delay || 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * opts.dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = opts.filterType || 'bandpass';
    filt.frequency.value = opts.freq || 1200;
    filt.Q.value = opts.q || 1;
    const g = ctx.createGain();
    g.gain.value = opts.vol != null ? opts.vol : 0.2;
    src.connect(filt); filt.connect(g); g.connect(AudioSys.master);
    src.start(t0);
  }

  /* ---------------- public SFX ---------------- */

  AudioSys.shoot = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('shoot')) return;
    tone({ type: 'triangle', f0: 620, f1: 240, dur: 0.09, vol: 0.18 });
    noise({ dur: 0.05, freq: 2400, vol: 0.06 });
  };

  AudioSys.bounce = function (speed) {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('bounce')) return;
    const f = 180 + Math.min(600, (speed || 400)) * 0.35;
    tone({ type: 'sine', f0: f, f1: f * 0.6, dur: 0.05, vol: 0.07 });
  };

  /** Block hit — ascending pitch while hits chain rapidly (combo ladder). */
  AudioSys.hit = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    const now = performance.now();
    if (now - AudioSys._lastHitT < 140) {
      AudioSys._comboStep = Math.min(12, AudioSys._comboStep + 1);
    } else if (now - AudioSys._lastHitT > 600) {
      AudioSys._comboStep = 0;
    }
    AudioSys._lastHitT = now;
    const semi = AudioSys._comboStep;
    if (playExternal('hit', semi)) return;
    const base = 330 * Math.pow(2, semi / 12);
    tone({ type: 'square', f0: base, f1: base * 1.5, dur: 0.06, vol: 0.10 });
  };

  AudioSys.destroy = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('destroy')) return;
    noise({ dur: 0.16, freq: 900, q: 0.7, vol: 0.22 });
    tone({ type: 'sawtooth', f0: 300, f1: 60, dur: 0.14, vol: 0.12 });
  };

  AudioSys.gate = function (mult) {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('gate')) return;
    const up = mult >= 2 ? 8 : 3;
    tone({ type: 'sine', f0: 500, f1: 500 * Math.pow(2, up / 12), dur: 0.16, vol: 0.2 });
    tone({ type: 'sine', f0: 750, f1: 750 * Math.pow(2, up / 12), dur: 0.16, vol: 0.12, delay: 0.03 });
  };

  AudioSys.merge = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('merge')) return;
    tone({ type: 'sine', f0: 160, f1: 90, dur: 0.1, vol: 0.14 });
  };

  AudioSys.waveClear = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('wave')) return;
    [0, 4, 7, 12].forEach(function (s, i) {
      tone({ type: 'triangle', f0: 440 * Math.pow(2, s / 12), dur: 0.12, vol: 0.16, delay: i * 0.07 });
    });
  };

  AudioSys.buy = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('buy')) return;
    tone({ type: 'square', f0: 880, f1: 1320, dur: 0.09, vol: 0.15 });
    tone({ type: 'square', f0: 1320, dur: 0.07, vol: 0.1, delay: 0.08 });
  };

  AudioSys.gameOver = function () {
    if (!AudioSys.enabled || !AudioSys.ctx) return;
    if (playExternal('gameover')) return;
    [0, -2, -5, -9].forEach(function (s, i) {
      tone({ type: 'sawtooth', f0: 330 * Math.pow(2, s / 12), f1: 330 * Math.pow(2, (s - 5) / 12), dur: 0.25, vol: 0.14, delay: i * 0.16 });
    });
  };

  global.RF = global.RF || {};
  global.RF.Audio = AudioSys;
})(window);
