/**
 * Chiptune audio for The Rare Agency.
 *
 * Everything is synthesised at runtime with the Web Audio API: square and triangle
 * oscillators for tones, filtered white noise for percussion. There are no audio files, so
 * nothing is downloaded and nothing needs licensing.
 *
 * The music is a slow spy-movie ostinato in E minor, the walking-bass idiom of a sixties
 * title sequence, kept deliberately sparse so it sits under the game rather than over it.
 *
 * Browsers refuse to start audio without a user gesture, so nothing sounds until unlock()
 * is called from a click, tap or keypress.
 */

export type SoundCue =
  | "pickup" | "pickup-major"
  /** One per trap type, so the kind of trap is audible before you read the log. */
  | "trap-bomb" | "trap-spring" | "trap-bucket"
  /** Your own trap catching somebody else, heard from anywhere on the map. */
  | "trap-sprung"
  | "hurt" | "heal" | "knife" | "takedown" | "downed" | "plant" | "search" | "door"
  | "deny" | "escape" | "lose";

const BPM = 92;
const BEAT = 60 / BPM;
const STEP = BEAT / 2;

/** Semitone offsets from A4 (440 Hz) to a frequency. */
const hz = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);

/** Note names used by the score below, as semitone offsets from A4. */
const N: Readonly<Record<string, number>> = {
  E1: -33, G1: -30, A1: -28, B1: -26, C2: -22, D2: -20, E2: -21, Fs2: -19,
  E3: -9, Fs3: -7, G3: -6, A3: -5, B3: -3, C4: 3, D4: 5, E4: 7, G4: 10, B4: 14,
};

/** Eight bars of ostinato. Each entry is one eighth-note step, or null for a rest. */
const BASS: readonly (number | null)[] = Object.freeze([
  N.E1, N.E1, N.E1, N.E1, N.G1, N.E1, N.A1, N.E1,
  N.E1, N.E1, N.E1, N.E1, N.G1, N.E1, N.B1, N.A1,
  N.E1, N.E1, N.E1, N.E1, N.G1, N.E1, N.A1, N.E1,
  N.C2, N.C2, N.B1, N.B1, N.A1, N.A1, N.G1, N.Fs2,
]);

/** A sparse answering line, mostly silence so it never fights the game. */
const LEAD: readonly (number | null)[] = Object.freeze([
  null, null, null, null, null, null, null, null,
  N.B3, null, N.G3, null, N.E3, null, null, null,
  null, null, null, null, null, null, null, null,
  N.C4, null, N.B3, null, N.A3, null, N.G3, null,
]);

export type Audio = ReturnType<typeof createAudio>;

export function createAudio() {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let effectBus: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  let muted = true;
  let musicOn = true;
  let playing = false;
  let step = 0;
  let nextStepAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function ensure(): AudioContext | null {
    if (context) return context;
    const Ctor: typeof AudioContext | undefined =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
    master = context.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(context.destination);

    musicBus = context.createGain();
    musicBus.gain.value = 0.30;
    musicBus.connect(master);

    effectBus = context.createGain();
    effectBus.gain.value = 0.85;
    effectBus.connect(master);

    // One second of white noise, reused for every percussive and explosive sound.
    noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return context;
  }

  /** A single enveloped oscillator note. */
  function tone(
    frequency: number, at: number, duration: number,
    { type = "square" as OscillatorType, gain = 0.2, bus = effectBus, glideTo = 0 } = {},
  ) {
    if (!context || !bus) return;
    const osc = context.createOscillator();
    const envelope = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    if (glideTo > 0) osc.frequency.exponentialRampToValueAtTime(glideTo, at + duration);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(envelope);
    envelope.connect(bus);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Filtered noise, for hats, impacts and explosions. */
  function noise(at: number, duration: number, { gain = 0.2, frequency = 1200, q = 1, type = "bandpass" as BiquadFilterType } = {}) {
    if (!context || !effectBus || !noiseBuffer) return;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, at);
    filter.Q.value = q;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(gain, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(effectBus);
    source.start(at);
    source.stop(at + duration + 0.02);
  }

  /** Schedule the next few steps of the loop, a little ahead of the clock. */
  function pump() {
    if (!context || !playing) return;
    const horizon = context.currentTime + 0.25;
    while (nextStepAt < horizon) {
      const index = step % BASS.length;
      const bass = BASS[index];
      if (bass !== null && bass !== undefined) {
        tone(hz(bass), nextStepAt, STEP * 0.92, { type: "triangle", gain: 0.42, bus: musicBus });
      }
      const lead = LEAD[index];
      if (lead !== null && lead !== undefined) {
        tone(hz(lead), nextStepAt, STEP * 1.7, { type: "square", gain: 0.13, bus: musicBus });
      }
      // A brushed hat on the offbeat keeps the pulse without a drum kit.
      if (index % 2 === 1) noise(nextStepAt, 0.045, { gain: 0.035, frequency: 7000, q: 0.7 });
      // A soft rim on beats two and four.
      if (index % 8 === 4) noise(nextStepAt, 0.09, { gain: 0.05, frequency: 2200, q: 2 });
      nextStepAt += STEP;
      step++;
    }
  }

  return {
    /** Must be called from a real user gesture before anything can sound. */
    async unlock() {
      const ctx = ensure();
      if (!ctx) return;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    },

    setMuted(value: boolean) {
      muted = value;
      if (master && context) {
        master.gain.setTargetAtTime(value ? 0 : 0.5, context.currentTime, 0.02);
      }
      if (!value) void this.unlock();
    },

    setMusic(value: boolean) {
      musicOn = value;
      if (value) this.startMusic(); else this.stopMusic();
    },

    startMusic() {
      if (!musicOn || playing) return;
      const ctx = ensure();
      if (!ctx) return;
      playing = true;
      step = 0;
      nextStepAt = ctx.currentTime + 0.1;
      pump();
      timer = setInterval(pump, 60);
    },

    stopMusic() {
      playing = false;
      if (timer) { clearInterval(timer); timer = null; }
    },

    play(sound: SoundCue) {
      const ctx = ensure();
      if (!ctx || muted) return;
      const at = ctx.currentTime + 0.001;
      switch (sound) {
        case "pickup":
          tone(hz(N.E4), at, 0.08, { gain: 0.18 });
          tone(hz(N.B4), at + 0.07, 0.12, { gain: 0.16 });
          break;
        case "pickup-major":
          tone(hz(N.E4), at, 0.08, { gain: 0.2 });
          tone(hz(N.G4), at + 0.07, 0.08, { gain: 0.2 });
          tone(hz(N.B4), at + 0.14, 0.22, { gain: 0.22 });
          break;
        // A deep detonation: broadband thump with the pitch dropping out from under it.
        case "trap-bomb":
          noise(at, 0.5, { gain: 0.5, frequency: 380, q: 0.6, type: "lowpass" });
          tone(hz(N.E2), at, 0.4, { type: "sawtooth", gain: 0.28, glideTo: hz(N.E1) });
          break;
        // A spring-gun: tight metallic twang, pitch snapping upward, then the bolt landing.
        case "trap-spring":
          tone(hz(N.E3), at, 0.09, { type: "square", gain: 0.24, glideTo: hz(N.B4) });
          noise(at + 0.05, 0.12, { gain: 0.26, frequency: 1800, q: 2.4 });
          tone(hz(N.E2), at + 0.12, 0.26, { type: "sawtooth", gain: 0.2, glideTo: hz(N.A1) });
          break;
        // A bucket: wet slap, then the pail rocking on the floorboards.
        case "trap-bucket":
          noise(at, 0.32, { gain: 0.3, frequency: 2600, q: 0.8 });
          tone(hz(N.B3), at, 0.22, { type: "sine", gain: 0.12, glideTo: hz(N.E3) });
          tone(hz(N.G3), at + 0.26, 0.1, { type: "triangle", gain: 0.1 });
          tone(hz(N.E3), at + 0.38, 0.12, { type: "triangle", gain: 0.08 });
          break;
        // Heard by the agent who set it: two rising notes, unmistakably good news.
        case "trap-sprung":
          tone(hz(N.B3), at, 0.08, { type: "square", gain: 0.16 });
          tone(hz(N.Fs3), at + 0.08, 0.16, { type: "square", gain: 0.16 });
          break;
        case "hurt":
          tone(hz(N.A3), at, 0.14, { type: "sawtooth", gain: 0.2, glideTo: hz(N.E3) });
          noise(at, 0.08, { gain: 0.16, frequency: 900, q: 1.2 });
          break;
        case "heal":
          tone(hz(N.E3), at, 0.1, { type: "triangle", gain: 0.2 });
          tone(hz(N.B3), at + 0.09, 0.1, { type: "triangle", gain: 0.2 });
          tone(hz(N.E4), at + 0.18, 0.2, { type: "triangle", gain: 0.2 });
          break;
        // The stiletto: a fast filtered swish, quite unlike the dull thud of a fist.
        case "knife":
          noise(at, 0.14, { gain: 0.24, frequency: 4200, q: 3.2 });
          tone(hz(N.B4), at, 0.1, { type: "sawtooth", gain: 0.12, glideTo: hz(N.E4) });
          break;
        case "takedown":
          tone(hz(N.E3), at, 0.1, { gain: 0.22 });
          tone(hz(N.G3), at + 0.08, 0.1, { gain: 0.22 });
          tone(hz(N.C4), at + 0.16, 0.24, { gain: 0.24 });
          break;
        case "downed":
          tone(hz(N.E3), at, 0.5, { type: "sawtooth", gain: 0.24, glideTo: hz(N.E1) });
          noise(at, 0.3, { gain: 0.18, frequency: 500, q: 0.7, type: "lowpass" });
          break;
        case "plant":
          tone(hz(N.G3), at, 0.05, { gain: 0.14 });
          tone(hz(N.D4), at + 0.06, 0.07, { gain: 0.14 });
          break;
        case "search":
          noise(at, 0.06, { gain: 0.1, frequency: 3200, q: 1.5 });
          break;
        case "door":
          tone(hz(N.A3), at, 0.06, { type: "triangle", gain: 0.12 });
          break;
        case "deny":
          tone(hz(N.E3), at, 0.1, { type: "square", gain: 0.14, glideTo: hz(N.C2) });
          break;
        case "escape": {
          // A short rising fanfare over the departure.
          const line = [N.E3, N.G3, N.B3, N.E4, N.G4, N.B4];
          line.forEach((note, index) => tone(hz(note), at + index * 0.11, 0.3, { gain: 0.22 }));
          break;
        }
        case "lose":
          [N.B3, N.A3, N.G3, N.E3].forEach((note, index) =>
            tone(hz(note), at + index * 0.16, 0.3, { type: "triangle", gain: 0.18 }));
          break;
      }
    },

    dispose() {
      this.stopMusic();
      try { void context?.close(); } catch { /* already closed */ }
      context = null; master = null; musicBus = null; effectBus = null; noiseBuffer = null;
    },
  };
}
