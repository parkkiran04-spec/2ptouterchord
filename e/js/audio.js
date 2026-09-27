// Audio: instruments, warm lo-fi effect chain, vinyl crackle, needle sounds, recorder.
(function () {
  'use strict';
  const A = (DG.audio = {
    ready: false,
    available: typeof window.Tone !== 'undefined',
    recording: false,
  });

  const inst = {};
  let initPromise = null;
  let limiter = null;
  let crackleGain = null;
  let thump = null;
  let dust = null;
  let heart = null;
  let noiseBed = null;
  let noiseBedGain = null;
  let analyser = null;
  let recorder = null;
  let lastDetune = 0;

  // Must be called from a user gesture.
  A.init = function () {
    if (initPromise) return initPromise;
    if (!A.available) return Promise.resolve(false);
    initPromise = Tone.start()
      .then(() => {
        build();
        A.ready = true;
        return true;
      })
      .catch((err) => {
        console.warn('[audio] could not start', err);
        initPromise = null;
        return false;
      });
    return initPromise;
  };

  function build() {
    const c = DG.config.audio;
    Tone.getContext().lookAhead = 0.02;

    limiter = new Tone.Limiter(-1).toDestination();
    // what the graphs on the background draw
    analyser = new Tone.Analyser('waveform', 256);
    limiter.connect(analyser);
    const comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.25 }).connect(limiter);
    const reverb = new Tone.Reverb({ decay: 3.2, preDelay: 0.02, wet: c.reverbWet }).connect(comp);
    const warmth = new Tone.Filter({ type: 'lowpass', frequency: c.lowpass, rolloff: -12, Q: 0.2 }).connect(reverb);
    const lowCut = new Tone.Filter({ type: 'highpass', frequency: 40 }).connect(warmth);
    const bus = new Tone.Gain(c.masterGain).connect(lowCut);

    const poly = (Voice, options, volume) => {
      const s = new Tone.PolySynth(Voice, options);
      s.maxPolyphony = c.maxPolyphony;
      s.volume.value = volume;
      s.connect(bus);
      return s;
    };

    inst.piano = poly(Tone.Synth, {
      oscillator: { type: 'custom', partials: [1, 0.45, 0.2, 0.09, 0.04] },
      envelope: { attack: 0.004, decay: 1.1, sustain: 0.06, release: 1.2 },
    }, -10);

    inst.marimba = poly(Tone.FMSynth, {
      harmonicity: 4,
      modulationIndex: 1.8,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.5 },
      modulationEnvelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.1 },
    }, -6);

    inst.bell = poly(Tone.FMSynth, {
      harmonicity: 5.07,
      modulationIndex: 7,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 1.8 },
      modulationEnvelope: { attack: 0.001, decay: 0.8, sustain: 0, release: 0.8 },
    }, -19);

    inst.bass = poly(Tone.MonoSynth, {
      oscillator: { type: 'sawtooth' },
      filter: { type: 'lowpass', Q: 1, rolloff: -24 },
      filterEnvelope: { attack: 0.005, decay: 0.25, sustain: 0.25, baseFrequency: 110, octaves: 2.2 },
      envelope: { attack: 0.008, decay: 0.3, sustain: 0.55, release: 0.35 },
    }, -11);

    inst.pad = poly(Tone.AMSynth, {
      harmonicity: 1.5,
      oscillator: { type: 'triangle' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.35, decay: 0.6, sustain: 0.65, release: 2.2 },
      modulationEnvelope: { attack: 0.5, decay: 0.2, sustain: 1, release: 1.5 },
    }, -17);

    // vinyl crackle loop (procedural buffer)
    crackleGain = new Tone.Gain(0).connect(limiter);
    const crackleHp = new Tone.Filter({ type: 'highpass', frequency: 450 }).connect(crackleGain);
    const crackleLp = new Tone.Filter({ type: 'lowpass', frequency: 7000 }).connect(crackleHp);
    const player = new Tone.Player(makeCrackleBuffer(Tone.getContext().sampleRate));
    player.loop = true;
    player.connect(crackleLp);
    player.start();

    // needle drop "thump" and lift "dust"
    thump = new Tone.MembraneSynth({
      pitchDecay: 0.03,
      octaves: 2.5,
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.05 },
    }).connect(limiter);
    thump.volume.value = -14;

    // ---- the two inner windows, heard as a background layer while the record plays ----
    heart = new Tone.MembraneSynth({
      pitchDecay: 0.06,
      octaves: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.34, sustain: 0, release: 0.1 },
    }).connect(bus);
    heart.volume.value = -13;

    noiseBedGain = new Tone.Gain(0).connect(bus);
    const noiseTone = new Tone.Filter({ type: 'lowpass', frequency: 900, rolloff: -24, Q: 1.2 }).connect(noiseBedGain);
    noiseBed = new Tone.Noise({ type: 'pink', volume: -6 }).connect(noiseTone);
    noiseBed.start();

    const dustHp = new Tone.Filter({ type: 'highpass', frequency: 900 }).connect(limiter);
    dust = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.02 },
    }).connect(dustHp);
    dust.volume.value = -20;
  }

  function makeCrackleBuffer(sr) {
    const seconds = 3.7;
    const len = Math.floor(sr * seconds);
    const data = new Float32Array(len);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.08 * (Math.random() * 2 - 1 - lp);
      data[i] = lp * 0.1;
    }
    const pops = Math.floor(seconds * 24);
    for (let p = 0; p < pops; p++) {
      const at = Math.floor(Math.random() * len);
      const amp = (0.12 + Math.pow(Math.random(), 2.5) * 0.85) * (Math.random() < 0.5 ? -1 : 1);
      const decay = 3 + Math.random() * 22;
      const n = Math.floor(decay * 6);
      for (let k = 0; k < n && at + k < len; k++) {
        data[at + k] += amp * Math.exp(-k / decay) * (k % 2 ? -0.55 : 1);
      }
    }
    const fade = Math.floor(sr * 0.02);
    for (let k = 0; k < fade; k++) {
      data[k] *= k / fade;
      data[len - 1 - k] *= k / fade;
    }
    return Tone.ToneAudioBuffer.fromArray(data);
  }

  // ---- playback ----
  A.now = () => (A.ready ? Tone.now() : 0);            // includes context lookAhead
  A.currentTime = () => (A.ready ? Tone.immediate() : 0);

  A.play = function (name, midi, time, duration, velocity) {
    if (!A.ready) return;
    const s = inst[name];
    if (!s) return;
    const t = Math.max(time, Tone.immediate());
    try {
      s.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), duration, t, velocity);
    } catch (err) {
      /* dropped note (e.g. polyphony exceeded) */
    }
  };

  // Record speed below target → pitch sags, like a real platter spinning up.
  A.setDetune = function (cents) {
    if (!A.ready || Math.abs(cents - lastDetune) < 4) return;
    lastDetune = cents;
    for (const k in inst) inst[k].set({ detune: cents });
  };

  A.setCrackle = function (on) {
    if (!A.ready) return;
    crackleGain.gain.rampTo(on ? DG.config.audio.crackle : 0, on ? 0.4 : 0.6);
  };

  A.thump = function () {
    if (!A.ready) return;
    thump.triggerAttackRelease('G1', 0.08, undefined, 0.7);
    dust.triggerAttackRelease(0.05);
  };

  A.dust = function () {
    if (!A.ready) return;
    dust.triggerAttackRelease(0.04);
  };

  // A soft heartbeat under the music: "lub" is lower and louder than "dub".
  A.heartbeat = function (strong, intensity) {
    if (!A.ready) return;
    const level = DG.config.audio.heart * (0.45 + 0.55 * intensity) * (strong ? 1 : 0.6);
    try {
      heart.triggerAttackRelease(strong ? 'C1' : 'F1', strong ? 0.2 : 0.14, undefined, Math.min(1, level));
    } catch (err) { /* ignore overlapping beats */ }
  };

  // Static from the noise window; level follows how much it is moving.
  A.setNoiseBed = function (level) {
    if (!A.ready) return;
    noiseBedGain.gain.rampTo(Math.max(0, level) * DG.config.audio.noiseBed, 0.2);
  };

  // The output waveform, -1…1, for the graphs on the background. Null until audio starts.
  A.waveform = function () {
    if (!A.ready || !analyser) return null;
    return analyser.getValue();
  };

  // ---- recording ----
  A.toggleRecording = async function () {
    if (!A.ready) {
      await A.init();
      if (!A.ready) return { error: 'Audio is not available' };
    }
    if (!Tone.Recorder || !Tone.Recorder.supported) return { error: 'Recording is not supported in this browser' };
    if (!A.recording) {
      recorder = new Tone.Recorder();
      limiter.connect(recorder);
      await recorder.start();
      A.recording = true;
      return { recording: true };
    }
    const blob = await recorder.stop();
    limiter.disconnect(recorder);
    recorder.dispose();
    recorder = null;
    A.recording = false;
    return { recording: false, blob };
  };
})();
