import * as THREE from 'three';

export type MusicEnergyBand = 'low' | 'medium' | 'high';
export type MusicDetectionMode = 'idle' | 'analysis' | 'external';

export interface MusicDebugInfo {
  active: boolean;
  mode: MusicDetectionMode;
  started: boolean;
  sourceConnected: boolean;
  /** smoothed instantaneous level 0..1 */
  level: number;
  /** slow sustained-energy average 0..1 (drives hysteresis) */
  sustained: number;
  /** low-band / total ratio (music typically has strong bass; speech does not) */
  bassRatio: number;
  band: MusicEnergyBand;
}

type MusicEvent = 'start' | 'stop';

/**
 * MusicActivityDetector (Phase 4).
 *
 * Reusable, ANUX-independent music/activity signal source. Two ways to know
 * music is playing:
 *
 * 1. External signal (primary for integration): `setMusicState(true/false)` —
 *    for a host (like ANUX) whose own system already classified the audio.
 * 2. Built-in analysis: `connectAudioSource(...)` + `start()` — Web Audio
 *    analysis with smoothing and hysteresis. The heuristic distinguishes
 *    sustained, bass-driven audio from intermittent speech as far as
 *    reasonably possible, but it is a heuristic: for guaranteed
 *    classification, use the external signal.
 *
 * Generic inputs: AudioNode, MediaStream, HTMLAudioElement, or an existing
 * AnalyserNode (`attachAnalyser`) when the host already runs one.
 *
 * Emits 'start' / 'stop' events only on state CHANGES (hysteresis: a rise must
 * be sustained ~1.2 s to activate; a drop must persist ~2.5 s to deactivate —
 * no START/STOP chatter from single spikes).
 */
export class MusicActivityDetector {
  mode: MusicDetectionMode = 'idle';
  private started = false;
  private active = false;

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;

  private level = 0;
  private sustained = 0;
  private bassRatio = 0;
  private onTimer = 0;
  private offTimer = 0;

  private readonly listeners: Record<MusicEvent, Set<() => void>> = { start: new Set(), stop: new Set() };

  // hysteresis thresholds
  private readonly ON_LEVEL = 0.12;
  private readonly ON_SUSTAINED = 0.14;
  private readonly OFF_LEVEL = 0.07;
  private readonly OFF_SUSTAINED = 0.08;
  private readonly ON_DELAY_S = 1.2;
  private readonly OFF_DELAY_S = 2.5;

  // ------------------------------------------------------------------ events

  on(event: MusicEvent, cb: () => void): void {
    this.listeners[event].add(cb);
  }

  off(event: MusicEvent, cb: () => void): void {
    this.listeners[event].delete(cb);
  }

  private emit(event: MusicEvent): void {
    for (const cb of this.listeners[event]) cb();
  }

  // ------------------------------------------------------------------ inputs

  /** Lazily creates (and reuses) the single shared AudioContext. */
  getAudioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Connects a generic audio source for analysis. Safe to call once per source. */
  connectAudioSource(source: AudioNode | MediaStream | HTMLAudioElement): void {
    const ctx = this.getAudioContext();
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.timeData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    }
    if (source instanceof AudioNode) {
      source.connect(this.analyser);
    } else if (source instanceof MediaStream) {
      this.mediaStreamSource = ctx.createMediaStreamSource(source);
      this.mediaStreamSource.connect(this.analyser);
    } else if (source instanceof HTMLAudioElement) {
      this.mediaElementSource = ctx.createMediaElementSource(source);
      this.mediaElementSource.connect(this.analyser);
    } else {
      throw new Error('MusicActivityDetector: unsupported audio source type');
    }
  }

  /** Lets a host plug in an analyser it already runs (ANUX seam). */
  attachAnalyser(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }

  /** Enables built-in analysis (requires a connected source or attached analyser). */
  start(): void {
    this.mode = 'analysis';
    this.started = true;
  }

  /** Disables built-in analysis. An externally set music state stays as-is. */
  stop(): void {
    this.started = false;
    if (this.mode === 'analysis') {
      this.mode = 'idle';
      if (this.active) this.deactivate();
    }
  }

  /**
   * External music signal — the integration seam. When used, it overrides the
   * built-in analysis until `start()` is called again.
   */
  setMusicState(active: boolean): void {
    this.mode = 'external';
    this.started = true;
    if (active === this.active) return;
    this.active = active;
    this.emit(active ? 'start' : 'stop');
  }

  isMusicActive(): boolean {
    return this.active;
  }

  /** Smoothed instantaneous level 0..1 (analysis mode only). */
  getLevel(): number {
    return this.level;
  }

  /** Energy classification from the slow sustained average. */
  getEnergyBand(): MusicEnergyBand {
    if (this.sustained < 0.18) return 'low';
    if (this.sustained < 0.4) return 'medium';
    return 'high';
  }

  getDebug(): MusicDebugInfo {
    return {
      active: this.active,
      mode: this.mode,
      started: this.started,
      sourceConnected: !!this.analyser,
      level: +this.level.toFixed(2),
      sustained: +this.sustained.toFixed(2),
      bassRatio: +this.bassRatio.toFixed(2),
      band: this.getEnergyBand(),
    };
  }

  // ------------------------------------------------------------------ update

  /** Called from the shared render loop (no own rAF, no allocations). */
  update(dt: number): void {
    if (this.mode !== 'analysis' || !this.started || !this.analyser || !this.timeData || !this.freqData) return;

    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);

    let sumSquares = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / this.timeData.length);

    // frequency bands (bins ≈ 46.9 Hz @48 kHz): low < ~470 Hz, mid to ~3.7 kHz
    const bins = this.freqData.length;
    let low = 0, total = 0;
    const lowEnd = Math.min(10, bins);
    for (let i = 0; i < bins; i++) {
      const v = this.freqData[i] / 255;
      total += v;
      if (i < lowEnd) low += v;
    }
    const targetBass = total > 0 ? low / total : 0;

    // asymmetric smoothing: fast attack, slow release
    const target = THREE.MathUtils.clamp(rms * 4.5, 0, 1);
    const k = target > this.level ? 1 - Math.exp(-dt * 8) : 1 - Math.exp(-dt * 2);
    this.level += (target - this.level) * k;
    this.sustained += (this.level - this.sustained) * (1 - Math.exp(-dt * 0.9));
    this.bassRatio += (targetBass - this.bassRatio) * (1 - Math.exp(-dt * 1.5));

    // hysteresis state machine
    if (!this.active) {
      const bassOk = this.bassRatio > 0.2 || this.sustained > 0.3;
      if (this.sustained > this.ON_SUSTAINED && this.level > this.ON_LEVEL && bassOk) {
        this.onTimer += dt;
        if (this.onTimer >= this.ON_DELAY_S) this.activate();
      } else {
        this.onTimer = 0;
      }
    } else {
      if (this.sustained < this.OFF_SUSTAINED && this.level < this.OFF_LEVEL) {
        this.offTimer += dt;
        if (this.offTimer >= this.OFF_DELAY_S) this.deactivate();
      } else {
        this.offTimer = 0;
      }
    }
  }

  private activate(): void {
    this.active = true;
    this.onTimer = 0;
    this.emit('start');
  }

  private deactivate(): void {
    this.active = false;
    this.offTimer = 0;
    this.emit('stop');
  }
}
