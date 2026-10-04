import { MusicActivityDetector } from './MusicActivityDetector';
import type { AvatarBrain } from './AvatarBrain';

/**
 * MusicController (Phase 4) — orchestrates the avatar's reaction to a music
 * signal. Owns the MusicActivityDetector, forwards start/stop events to the
 * brain, and provides the developer test signal (a synthesized music-like
 * loop — this is NOT a music player; the real source will come from the host).
 */
export class MusicController {
  readonly detector: MusicActivityDetector;
  private brain: AvatarBrain | null = null;
  private testSource: AudioBufferSourceNode | null = null;
  private testGain: GainNode | null = null;

  constructor(detector: MusicActivityDetector) {
    this.detector = detector;
    this.detector.on('start', () => this.brain?.handleMusicStart());
    this.detector.on('stop', () => this.brain?.handleMusicEnd());
  }

  attachBrain(brain: AvatarBrain): void {
    this.brain = brain;
  }

  /** ANUX seam: set the music signal directly (overrides built-in analysis). */
  setMusicState(active: boolean): void {
    this.detector.setMusicState(active);
  }

  /** Dev test: synthesize a music-like loop, play it quietly, and analyze it. */
  startAnalysisTest(): void {
    this.stopAnalysisTest();
    const ctx = this.detector.getAudioContext();
    void ctx.resume();
    const buffer = createMusicTestBuffer(ctx);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    this.testSource = source;
    this.testGain = gain;
    this.detector.connectAudioSource(source);
    this.detector.start();
  }

  stopAnalysisTest(): void {
    if (this.testSource) {
      try {
        this.testSource.stop();
      } catch {
        // already stopped
      }
      this.testSource.disconnect();
      this.testSource = null;
    }
    if (this.testGain) {
      this.testGain.disconnect();
      this.testGain = null;
    }
    this.detector.stop();
  }

  get testRunning(): boolean {
    return this.testSource !== null;
  }

  getDebug() {
    return {
      ...this.detector.getDebug(),
      testRunning: this.testRunning,
    };
  }
}

/**
 * Dev test signal: an 8-second synthesized music-like loop (120 BPM kick,
 * offbeat hats, simple bass line) — sufficient for exercising the detector's
 * sustain/hysteresis/bass heuristics. Not a music player.
 */
export function createMusicTestBuffer(ctx: AudioContext, durationS = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(sampleRate * durationS), sampleRate);
  const data = buffer.getChannelData(0);
  const beat = 0.5; // 120 BPM
  let lowpass = 0;

  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const beatIndex = Math.floor(t / beat);
    const beatPhase = (t % beat) / beat;

    // kick: pitch sweep 150→45 Hz with exponential decay, on every beat
    let sample = 0;
    const kickT = t - beatIndex * beat;
    if (kickT < 0.16) {
      const freq = 45 + 105 * Math.exp(-kickT * 26);
      sample += Math.sin(2 * Math.PI * (freq * kickT + 20 * Math.exp(-kickT * 8))) * Math.exp(-kickT * 14) * 0.9;
    }
    // hat: high-passed noise burst on the offbeat
    const hatT = t - (beatIndex * beat + beat / 2);
    if (hatT >= 0 && hatT < 0.045) {
      const noise = Math.random() * 2 - 1;
      lowpass += 0.25 * (noise - lowpass);
      sample += (noise - lowpass) * Math.exp(-hatT * 90) * 0.35;
    }
    // bass note: alternates per bar, decays over the beat
    const barNote = [55, 55, 65.4, 49][Math.floor(beatIndex / 2) % 4];
    sample += Math.sin(2 * Math.PI * barNote * t) * (1 - beatPhase) * 0.28;

    data[i] = sample * 0.6;
  }
  return buffer;
}
