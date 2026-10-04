import * as THREE from 'three';
import type { ExpressionEngine } from './Expressions';

/**
 * LipSyncController (Phase 3).
 *
 * Primary path: a viseme timeline [{ time, viseme, intensity }] is sampled and
 * blended into morph targets each frame. The viseme set is adapted to what this
 * model ACTUALLY provides — vowel morphs Fcl_MTH_A/I/U/E/O plus mouth consonant
 * helpers (Fcl_MTH_Close/Up/Down/Small) — no invented names.
 *
 * Fallback path: when only audio is available, an AnalyserNode drives mouth
 * openness from RMS amplitude and picks vowels from the spectral centroid
 * (with hysteresis so the vowel doesn't flicker). Volume-based opening is a
 * fallback only — the timeline API is the primary architecture, ready for real
 * phoneme/viseme timing from a future TTS.
 *
 * This module is independent from ANUX: `start` accepts a viseme timeline, an
 * AudioBuffer, an audio URL, or `synthetic: true` for a generated test speech
 * rhythm.
 */

export interface VisemeKey {
  /** seconds from speech start */
  time: number;
  viseme: string;
  /** 0..1 */
  intensity: number;
}

export interface SpeakOptions {
  /** primary: explicit viseme timeline */
  visemeTimeline?: VisemeKey[];
  /** fallback: analyze preloaded audio */
  audioBuffer?: AudioBuffer;
  /** fallback: fetch + analyze an audio URL */
  audioUrl?: string;
  /** dev test: generate a speech-like viseme timeline (silent) */
  synthetic?: boolean;
  /** dev test options for the synthetic timeline */
  syntheticSpeed?: number;
  syntheticDurationS?: number;
  /** playback volume for the audio fallback (0..1, default 0.9) */
  outputGain?: number;
}

/**
 * Viseme → morph recipes. Every morph name below exists on this model
 * (verified by tools/inspect-assets.mjs). Consonant visemes use closed/narrow
 * mouth helpers at reduced weight, the way vowel-based rigs conventionally
 * approximate them.
 */
export const VISEME_RECIPES: Record<string, Array<[string, number]>> = {
  sil: [['Fcl_MTH_Close', 0.35]],
  A: [['Fcl_MTH_A', 1]],
  I: [['Fcl_MTH_I', 0.9]],
  U: [['Fcl_MTH_U', 0.95]],
  E: [['Fcl_MTH_E', 0.9]],
  O: [['Fcl_MTH_O', 1]],
  M: [['Fcl_MTH_Close', 0.9]],
  F: [['Fcl_MTH_Close', 0.55], ['Fcl_MTH_Down', 0.3]],
  L: [['Fcl_MTH_Close', 0.3], ['Fcl_MTH_A', 0.25]],
  S: [['Fcl_MTH_I', 0.5], ['Fcl_MTH_Close', 0.2]],
  CH: [['Fcl_MTH_U', 0.5], ['Fcl_MTH_Small', 0.4]],
  R: [['Fcl_MTH_O', 0.4], ['Fcl_MTH_Up', 0.2]],
  TH: [['Fcl_MTH_Close', 0.25], ['Fcl_MTH_E', 0.2]],
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export class LipSyncController {
  private engine: ExpressionEngine;
  private isSpeaking = false;
  private clock = 0;

  // timeline mode
  private timeline: VisemeKey[] = [];
  private timelineEnd = 0;

  // audio fallback mode
  private audio: {
    ctx: AudioContext;
    analyser: AnalyserNode;
    source: AudioBufferSourceNode;
    timeData: Uint8Array<ArrayBuffer>;
    freqData: Uint8Array<ArrayBuffer>;
  } | null = null;
  private fallbackVowel = 'A';
  private lastVowelSwitch = 0;

  // smoothed output
  private targets = new Map<string, number>();
  private openness = 0;
  private currentViseme = 'sil';
  private currentIntensity = 0;

  constructor(engine: ExpressionEngine) {
    this.engine = engine;
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  /** 0..1 speech energy — the brain feeds this into head-emphasis motion. */
  get energy(): number {
    return this.isSpeaking ? Math.min(1, this.openness * 1.6) : 0;
  }

  getDebug(): { speaking: boolean; mode: 'timeline' | 'audio' | null; viseme: string; intensity: number; openness: number } {
    return {
      speaking: this.isSpeaking,
      mode: this.audio ? 'audio' : this.timeline.length ? 'timeline' : null,
      viseme: this.currentViseme,
      intensity: +this.currentIntensity.toFixed(2),
      openness: +this.openness.toFixed(2),
    };
  }

  start(options: SpeakOptions): void {
    this.stop(true);
    if (options.visemeTimeline?.length) {
      this.timeline = [...options.visemeTimeline].sort((a, b) => a.time - b.time);
      this.timelineEnd = this.timeline[this.timeline.length - 1].time + 0.18; // small closing tail
      this.isSpeaking = true;
    } else if (options.audioBuffer) {
      this.startAudio(options.audioBuffer, options.outputGain ?? 0.9);
    } else if (options.audioUrl) {
      void this.startAudioUrl(options.audioUrl, options.outputGain ?? 0.9);
    } else if (options.synthetic) {
      this.start({ visemeTimeline: generateSyntheticTimeline(options.syntheticSpeed ?? 1, options.syntheticDurationS ?? 6) });
    } else {
      return;
    }
    this.clock = 0;
  }

  /** Smooth stop: targets clear, the engine lerp closes the mouth naturally. */
  stop(immediate = false): void {
    this.isSpeaking = false;
    this.timeline = [];
    this.teardownAudio();
    if (immediate) {
      this.targets.clear();
      this.engine.setLipSyncTargets(null);
    }
    // non-immediate: targets are dropped on the next update, engine lerp closes the mouth
  }

  /** Frame update — runs from the brain, after the mixer update. */
  update(dt: number): void {
    if (!this.isSpeaking) {
      if (this.targets.size) {
        this.targets.clear();
        this.engine.setLipSyncTargets(null);
      }
      return;
    }
    this.clock += dt;

    if (this.audio) {
      this.updateAudioAnalysis(dt);
    } else {
      this.updateTimeline();
    }

    this.engine.setLipSyncTargets(this.targets.size ? [...this.targets.entries()] : null);
  }

  // ---------------------------------------------------------------- timeline

  private updateTimeline(): void {
    if (this.clock >= this.timelineEnd) {
      this.stop();
      return;
    }
    // find surrounding keys
    let prev: VisemeKey | null = null;
    let next: VisemeKey | null = null;
    for (const key of this.timeline) {
      if (key.time <= this.clock) prev = key;
      else { next = key; break; }
    }
    const merged = new Map<string, number>();
    const apply = (key: VisemeKey, weight: number) => {
      const recipe = VISEME_RECIPES[key.viseme] ?? VISEME_RECIPES.A;
      for (const [morph, base] of recipe) {
        merged.set(morph, Math.max(merged.get(morph) ?? 0, base * key.intensity * weight));
      }
    };
    if (prev && next) {
      const span = next.time - prev.time;
      const f = span > 1e-4 ? (this.clock - prev.time) / span : 1;
      apply(prev, 1 - f);
      apply(next, f);
      this.currentViseme = f < 0.5 ? prev.viseme : next.viseme;
      this.currentIntensity = f < 0.5 ? prev.intensity : next.intensity;
    } else if (prev) {
      // past the last key: ease toward closed
      const tail = THREE.MathUtils.clamp(1 - (this.clock - prev.time) / 0.18, 0, 1);
      apply(prev, tail);
      this.currentViseme = prev.viseme;
      this.currentIntensity = prev.intensity * tail;
    } else if (next) {
      apply(next, 1);
      this.currentViseme = next.viseme;
      this.currentIntensity = next.intensity;
    }
    this.openness = this.currentIntensity;
    this.targets.clear();
    for (const [k, v] of merged) {
      if (v > 0.01) this.targets.set(k, v);
    }
  }

  // ---------------------------------------------------------- audio fallback

  private async startAudioUrl(url: string, gain: number): Promise<void> {
    try {
      const ctx = this.ensureContext();
      const res = await fetch(url);
      const data = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      // the user may have called stop() while decoding
      if (this.isSpeaking) return;
      this.startAudio(buffer, gain);
    } catch (err) {
      console.error('[avatar] lipsync audio load failed', err);
      this.isSpeaking = false;
    }
  }

  private startAudio(buffer: AudioBuffer, gain: number): void {
    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.onended = () => {
      this.isSpeaking = false;
      this.teardownAudio();
    };
    source.start();
    this.audio = {
      ctx,
      analyser,
      source,
      timeData: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      freqData: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    };
    this.isSpeaking = true;
    this.clock = 0;
  }

  private updateAudioAnalysis(dt: number): void {
    const audio = this.audio;
    if (!audio) return;
    audio.analyser.getByteTimeDomainData(audio.timeData);
    audio.analyser.getByteFrequencyData(audio.freqData);

    // RMS amplitude → mouth openness
    let sum = 0;
    for (let i = 0; i < audio.timeData.length; i++) {
      const v = (audio.timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / audio.timeData.length);
    const openness = THREE.MathUtils.clamp(rms * 5.5, 0, 1);

    // spectral centroid → vowel family (with hysteresis against flicker)
    let weighted = 0;
    let total = 0;
    for (let i = 0; i < audio.freqData.length; i++) {
      const mag = audio.freqData[i];
      weighted += mag * i;
      total += mag;
    }
    const centroid = total > 0 ? weighted / total / audio.freqData.length : 0;
    if (this.clock - this.lastVowelSwitch > 0.09) {
      let vowel = this.fallbackVowel;
      if (centroid < 0.16) vowel = Math.random() < 0.5 ? 'A' : 'O';
      else if (centroid < 0.28) vowel = Math.random() < 0.6 ? 'E' : 'O';
      else vowel = Math.random() < 0.6 ? 'I' : 'U';
      if (vowel !== this.fallbackVowel) {
        this.fallbackVowel = vowel;
        this.lastVowelSwitch = this.clock;
      }
    }

    this.currentViseme = openness < 0.08 ? 'sil' : this.fallbackVowel;
    this.currentIntensity = openness;
    this.openness = openness;

    this.targets.clear();
    if (openness < 0.08) {
      this.targets.set('Fcl_MTH_Close', 0.35 * (1 - openness / 0.08));
    } else {
      const recipe = VISEME_RECIPES[this.fallbackVowel];
      for (const [morph, base] of recipe) this.targets.set(morph, base * (0.45 + 0.55 * openness));
    }
    void dt;
  }

  private ensureContext(): AudioContext {
    return this.audio?.ctx ?? new AudioContext();
  }

  /**
   * Dev test signal: a few seconds of synthesized speech-like babble (syllable
   * envelope + low-passed noise + ~110 Hz voiced buzz) for exercising the
   * audio-analysis fallback without any audio assets.
   */
  createBabbleBuffer(durationS = 3): AudioBuffer {
    const ctx = this.ensureContext();
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.floor(sampleRate * durationS), sampleRate);
    const data = buffer.getChannelData(0);
    let lowpass = 0;
    let phase = 0;
    const syllableRate = 5.2;
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const syllable = Math.sin(Math.PI * ((t * syllableRate) % 1));
      const phrase = 0.6 + 0.4 * Math.sin(t * 0.9);
      const env = Math.max(0, syllable * phrase);
      const noise = Math.random() * 2 - 1;
      lowpass += 0.16 * (noise - lowpass);
      phase += (110 * (1 + 0.25 * Math.sin(t * 2.8))) / sampleRate;
      const buzz = Math.sin(phase * Math.PI * 2) * 0.55;
      data[i] = (lowpass * 0.75 + buzz) * env * 0.5;
    }
    return buffer;
  }

  private teardownAudio(): void {
    if (!this.audio) return;
    try {
      this.audio.source.onended = null;
      this.audio.source.stop();
    } catch {
      // already stopped
    }
    this.audio.source.disconnect();
    this.audio.analyser.disconnect();
    this.audio = null;
  }
}

/**
 * Generates a speech-like viseme timeline for testing the primary path without
 * any audio: syllable rhythm, vowel/consonant alternation, intensity variety,
 * and breathing pauses.
 */
export function generateSyntheticTimeline(speed = 1, durationS = 6): VisemeKey[] {
  const keys: VisemeKey[] = [{ time: 0, viseme: 'sil', intensity: 0 }];
  const vowels = ['A', 'E', 'I', 'O', 'U'];
  const consonants = ['M', 'L', 'S', 'F', 'CH', 'R', 'TH'];
  let t = 0.1;
  let lastVowel = '';
  while (t < durationS) {
    // word: 1-4 syllables
    const syllables = Math.floor(rand(1, 4.999));
    for (let s = 0; s < syllables && t < durationS; s++) {
      if (Math.random() < 0.3) {
        const c = consonants[Math.floor(rand(0, consonants.length))];
        keys.push({ time: +t.toFixed(3), viseme: c, intensity: +rand(0.35, 0.6).toFixed(2) });
        t += rand(0.05, 0.09) / speed;
      }
      let v = vowels[Math.floor(rand(0, vowels.length))];
      if (v === lastVowel) v = vowels[(vowels.indexOf(v) + 1 + Math.floor(rand(0, 3))) % vowels.length];
      lastVowel = v;
      keys.push({ time: +t.toFixed(3), viseme: v, intensity: +rand(0.55, 0.95).toFixed(2) });
      t += rand(0.11, 0.2) / speed;
    }
    // breathing / phrase pause
    keys.push({ time: +t.toFixed(3), viseme: 'sil', intensity: 0 });
    t += rand(0.18, 0.5) / speed;
  }
  keys.push({ time: +durationS.toFixed(3), viseme: 'sil', intensity: 0 });
  return keys;
}
