// Small procedural sound layer. It has no assets and creates its AudioContext only
// after a user gesture, so browsers that block Web Audio can still run the game.
const GameAudio = (() => {
  const STORAGE_KEY = 'pixel2d-audio-muted';
  const MAX_VOICES = 14;
  const MASTER_GAIN = 0.55;
  const ELEMENTS = {
    Fire:      { cast: [170, 320, 520], impact: [95, 180, 380], wave: 'sawtooth' },
    Water:     { cast: [260, 390, 610], impact: [150, 300, 460], wave: 'sine' },
    Earth:     { cast: [78, 125, 205], impact: [55, 90, 155], wave: 'triangle' },
    Lightning: { cast: [310, 640, 980], impact: [190, 480, 850], wave: 'square' },
    Dark:      { cast: [105, 155, 250], impact: [48, 82, 190], wave: 'sawtooth' },
    Arcane:    { cast: [220, 440, 740], impact: [125, 250, 590], wave: 'triangle' },
  };
  let context = null;
  let master = null;
  let voices = 0;
  let muted = false;
  let lastSound = Object.create(null);
  let domButton = null;
  let lastListener = null;
  let resumePromise = null;
  let audioUnavailable = false;
  let pendingCue = null;
  let limiter = null;

  try { muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { /* storage can be disabled */ }

  function setButtonText() {
    if (!domButton) return;
    const running = context && context.state === 'running';
    domButton.textContent = audioUnavailable ? 'Sound unavailable'
      : muted ? 'Sound: off (M)'
        : running ? 'Sound: on (M)' : 'Enable sound (M)';
    domButton.setAttribute('aria-pressed', String(muted));
    domButton.setAttribute('aria-label', audioUnavailable ? 'Sound unavailable'
      : running && !muted ? 'Mute game sound' : 'Enable game sound');
  }

  function setBusGain() {
    if (!master || !context) return;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(muted || document.hidden ? 0 : MASTER_GAIN, now, 0.025);
  }

  function setMuted(value) {
    muted = !!value;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch (e) { /* keep the session preference */ }
    setBusGain();
    setButtonText();
  }

  function init() {
    if (context) return context;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) { audioUnavailable = true; setButtonText(); return null; }
    try {
      context = new AudioContextCtor();
      master = context.createGain();
      master.gain.value = muted || document.hidden ? 0 : MASTER_GAIN;
      try {
        limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.12;
        master.connect(limiter);
        limiter.connect(context.destination);
      } catch (e) {
        limiter = null;
        master.connect(context.destination);
      }
      audioUnavailable = false;
      context.addEventListener('statechange', () => {
        if (context && context.state === 'closed') audioUnavailable = true;
        setButtonText();
      });
      setButtonText();
      return context;
    } catch (e) {
      context = null;
      master = null;
      audioUnavailable = true;
      setButtonText();
      return null;
    }
  }

  function flushPendingCue() {
    const cue = pendingCue;
    pendingCue = null;
    if (cue && Date.now() <= cue.expires && context && context.state === 'running' && !muted && !document.hidden) {
      play(cue.kind, cue.element, cue.x, cue.y, cue.extra, false);
    }
  }

  function unlock(options = {}) {
    const ctx = init();
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') {
      if (options.enable) setMuted(false);
      setBusGain();
      setButtonText();
      flushPendingCue();
      if (options.confirm && !muted && !document.hidden) play('enable', null, null, null, {}, false);
      return Promise.resolve(true);
    }
    if (!resumePromise) {
      let attempt;
      try { attempt = ctx.resume(); } catch (e) { attempt = Promise.reject(e); }
      resumePromise = Promise.resolve(attempt).then(() => {
        return context === ctx && ctx.state === 'running';
      }).catch(() => {
        setButtonText();
        return false;
      }).finally(() => { resumePromise = null; });
    }
    return resumePromise.then((ready) => {
      if (!ready) return false;
      if (options.enable) setMuted(false);
      else setBusGain();
      setButtonText();
      flushPendingCue();
      if (options.confirm && !muted && !document.hidden) play('enable', null, null, null, {}, false);
      return true;
    });
  }

  function toggleFromGesture() {
    if (context && context.state === 'running' && !muted) {
      setMuted(true);
      return;
    }
    unlock({ enable: true, confirm: true });
  }

  function isTypingTarget(target) {
    return !!(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
  }

  function isAudioControl(target) {
    if (!target) return false;
    if (target === domButton) return true;
    return typeof target.closest === 'function' && !!target.closest('#audio-toggle');
  }

  function volumeAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 1;
    const scene = window.game && window.game.scene && window.game.scene.getScene('sand');
    const player = scene && scene.player;
    if (!player) return 1;
    const px = player.x + player.w / 2, py = player.y + player.h / 2;
    return 0.18 + 0.82 * Math.max(0, 1 - Math.hypot(x - px, y - py) / 1150);
  }

  function tone(frequency, duration, options = {}) {
    if (voices >= MAX_VOICES) return;
    const ctx = context;
    if (!ctx || !master || ctx.state !== 'running' || muted || document.hidden) return;
    voices++;
    const now = ctx.currentTime + (options.delay || 0);
    let osc, gain, filter;
    try {
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      filter = ctx.createBiquadFilter();
      osc.type = options.wave || 'sine';
      osc.frequency.setValueAtTime(Math.max(25, frequency), now);
      if (options.endFrequency) osc.frequency.exponentialRampToValueAtTime(Math.max(25, options.endFrequency), now + duration);
      filter.type = options.filter || 'lowpass';
      filter.frequency.setValueAtTime(options.cutoff || 2600, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(options.gain || 0.075, now + Math.min(0.012, duration * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.onended = () => {
        try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) { /* already disconnected */ }
        voices = Math.max(0, voices - 1);
      };
      osc.start(now);
      osc.stop(now + duration + 0.015);
    } catch (e) {
      voices = Math.max(0, voices - 1);
      try { osc && osc.disconnect(); filter && filter.disconnect(); gain && gain.disconnect(); } catch (ignored) { /* partial setup */ }
    }
  }

  function noise(duration, options = {}) {
    if (voices >= MAX_VOICES || !context || !master || context.state !== 'running' || muted || document.hidden) return;
    const ctx = context;
    voices++;
    let source, gain, filter;
    try {
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      gain = ctx.createGain();
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = options.cutoff || 700;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(options.gain || 0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.onended = () => {
        try { source.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) { /* already disconnected */ }
        voices = Math.max(0, voices - 1);
      };
      source.start(now);
      source.stop(now + duration + 0.01);
    } catch (e) {
      voices = Math.max(0, voices - 1);
      try { source && source.disconnect(); filter && filter.disconnect(); gain && gain.disconnect(); } catch (ignored) { /* partial setup */ }
    }
  }

  function allowed(key, cooldown) {
    const now = Date.now();
    if (now - (lastSound[key] || 0) < cooldown) return false;
    lastSound[key] = now;
    return true;
  }

  function play(kind, element, x, y, extra = {}, bufferWhileUnlocking = true) {
    // Do not consume a cooldown while the context is still waiting for its first
    // gesture, muted, or silenced in a hidden tab.
    if (!context || context.state !== 'running') {
      if (bufferWhileUnlocking && context && !muted && !document.hidden) {
        pendingCue = { kind, element, x, y, extra, expires: Date.now() + 480 };
      }
      return;
    }
    if (muted || document.hidden) return;
    const palette = ELEMENTS[element] || ELEMENTS.Arcane;
    const positionGain = volumeAt(x, y);
    const strength = Math.max(0.35, Math.min(1.5, extra.strength || 1));
    if (kind === 'cast') {
      const key = `cast:${element}`;
      if (!allowed(key, 85)) return;
      tone(palette.cast[0], 0.19, { wave: palette.wave, endFrequency: palette.cast[0] * 1.55, gain: 0.055 * positionGain });
      tone(palette.cast[1], 0.13, { delay: 0.035, wave: 'triangle', endFrequency: palette.cast[1] * 0.82, gain: 0.035 * positionGain });
      if (element === 'Lightning' || element === 'Arcane' || element === 'Water') {
        tone(palette.cast[2], 0.09, { delay: 0.02, wave: 'sine', endFrequency: palette.cast[2] * 1.18, gain: 0.025 * positionGain });
      }
      return;
    }
    if (kind === 'impact') {
      const key = `impact:${element}`;
      if (!allowed(key, extra.minor ? 140 : 90)) return;
      tone(palette.impact[0], 0.25, { wave: palette.wave, endFrequency: palette.impact[0] * 0.48, gain: 0.095 * positionGain * strength, cutoff: 1500 });
      tone(palette.impact[1], 0.15, { delay: 0.012, wave: 'triangle', endFrequency: palette.impact[1] * 0.7, gain: 0.045 * positionGain * strength });
      if (element === 'Lightning' || element === 'Arcane' || element === 'Water') {
        tone(palette.impact[2], 0.11, { delay: 0.018, wave: 'sine', endFrequency: palette.impact[2] * 0.7, gain: 0.026 * positionGain * strength });
      }
      return;
    }
    if (kind === 'blast') {
      const key = `blast:${Math.round((x || 0) / 200)}:${Math.round((y || 0) / 200)}`;
      if (!allowed(key, 95)) return;
      tone(58, 0.34, { wave: 'sine', endFrequency: 32, gain: 0.115 * positionGain * strength, cutoff: 420 });
      tone(105, 0.2, { delay: 0.018, wave: 'triangle', endFrequency: 48, gain: 0.038 * positionGain * strength, cutoff: 650 });
      noise(0.16, { gain: 0.03 * positionGain * strength, cutoff: 540 });
      return;
    }
    if (kind === 'jump') {
      if (!allowed('jump', 110)) return;
      tone(205, 0.11, { wave: 'triangle', endFrequency: 330, gain: 0.035 });
    } else if (kind === 'hurt') {
      if (!allowed('hurt', 260)) return;
      tone(155, 0.2, { wave: 'sawtooth', endFrequency: 72, gain: 0.055 * positionGain, cutoff: 850 });
      noise(0.11, { gain: 0.018 * positionGain, cutoff: 900 });
    } else if (kind === 'death') {
      if (!allowed('death', 600)) return;
      tone(135, 0.52, { wave: 'triangle', endFrequency: 42, gain: 0.075 * positionGain, cutoff: 600 });
      tone(205, 0.36, { delay: 0.05, wave: 'sine', endFrequency: 55, gain: 0.026 * positionGain, cutoff: 900 });
    } else if (kind === 'menuMove') {
      if (!allowed('menuMove', 55)) return;
      tone(520, 0.055, { wave: 'sine', endFrequency: 680, gain: 0.018, cutoff: 1800 });
    } else if (kind === 'menuConfirm') {
      if (!allowed('menuConfirm', 75)) return;
      tone(440, 0.09, { wave: 'triangle', endFrequency: 660, gain: 0.028, cutoff: 1800 });
      tone(660, 0.08, { delay: 0.035, wave: 'sine', endFrequency: 880, gain: 0.018, cutoff: 2200 });
    } else if (kind === 'enable') {
      tone(660, 0.1, { wave: 'sine', endFrequency: 880, gain: 0.042, cutoff: 2400 });
      tone(880, 0.12, { delay: 0.06, wave: 'sine', endFrequency: 1100, gain: 0.032, cutoff: 2600 });
    }
  }

  function bindButton(button) {
    domButton = button;
    let keyboardActivation = false;
    setButtonText();
    button.addEventListener('click', () => {
      if (keyboardActivation) { keyboardActivation = false; return; }
      toggleFromGesture();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      keyboardActivation = true;
      toggleFromGesture();
    });
    button.addEventListener('keyup', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      event.stopPropagation();
      // Space normally synthesizes click on keyup. Ignore that browser click after
      // already handling the keydown, then clear the guard even if no click follows.
      keyboardActivation = true;
      setTimeout(() => { keyboardActivation = false; }, 0);
    });
    button.addEventListener('blur', () => { keyboardActivation = false; });
    if (lastListener) window.removeEventListener('keydown', lastListener, true);
    lastListener = (event) => {
      if (event.repeat || String(event.key).toLowerCase() !== 'm') return;
      if (event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) return;
      const activeScene = window.game && window.game.scene && window.game.scene.getScenes(true)[0];
      if (activeScene && activeScene.scene && activeScene.scene.key === 'menu'
        && ['join', 'create'].includes(activeScene.screen)) return;
      toggleFromGesture();
    };
    document.addEventListener('pointerdown', (event) => {
      if (!isAudioControl(event.target)) unlock();
    }, { capture: true, passive: true });
    document.addEventListener('keydown', (event) => {
      if (String(event.key).toLowerCase() === 'm' || isAudioControl(event.target)) return;
      unlock();
    }, { capture: true, passive: true });
    window.addEventListener('keydown', lastListener, { capture: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (!context || !master) return;
    if (document.hidden) {
      master.gain.setTargetAtTime(0, context.currentTime, 0.015);
    } else {
      // One-shots are short and bounded, so muting the bus avoids a suspend/resume
      // race while still silencing the page whenever it is hidden.
      setBusGain();
      if (context.state === 'suspended' || context.state === 'interrupted') unlock();
    }
  });

  return {
    bindButton,
    unlock,
    setMuted,
    toggle() { toggleFromGesture(); },
    cast(element, x, y) { play('cast', element, x, y); },
    impact(element, x, y, extra) { play('impact', element, x, y, extra); },
    blast(x, y, strength) { play('blast', 'Earth', x, y, { strength }); },
    jump(x, y) { play('jump', null, x, y); },
    hurt(element, x, y) { play('hurt', element, x, y); },
    death(x, y) { play('death', null, x, y); },
    menuMove() { play('menuMove'); },
    menuConfirm() { play('menuConfirm'); },
  };
})();
