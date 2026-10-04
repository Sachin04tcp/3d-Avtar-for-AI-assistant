import * as THREE from 'three';

interface MorphBinding {
  mesh: THREE.Mesh;
  dictionary: Record<string, number>;
  influences: number[];
}

/**
 * Low-level facial morph engine (Phase 2/3).
 *
 * Smoothly blends toward merged morph weights — emotion base (set by the
 * emotion system / behavior overlays), lip-sync targets (set by the
 * LipSyncController), and a blink pulse — and writes the influences each
 * frame. Knows nothing about timing or emotions; callers own those.
 */
export class ExpressionEngine {
  private bindings: MorphBinding[] = [];
  private current = new Map<string, number>();
  private target = new Map<string, number>();
  private lipSync = new Map<string, number>();
  private blinkPulse = 0;

  constructor(meshes: THREE.Mesh[]) {
    for (const mesh of meshes) {
      const dictionary = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;
      if (!dictionary || !influences) continue;
      this.bindings.push({ mesh, dictionary, influences });
    }
  }

  get available(): boolean {
    return this.bindings.length > 0;
  }

  hasMorph(name: string): boolean {
    return this.bindings.some((b) => name in b.dictionary);
  }

  /** Replace the desired morph weights (emotion base + overlays, already merged). */
  setTargets(morphs: Array<[string, number]>): void {
    this.target.clear();
    for (const [name, weight] of morphs) this.target.set(name, weight);
  }

  /** Replace the lip-sync morph weights (merged over the emotion base with max()). */
  setLipSyncTargets(morphs: Array<[string, number]> | null): void {
    this.lipSync.clear();
    if (morphs) for (const [name, weight] of morphs) this.lipSync.set(name, weight);
  }

  /** Called every frame by the blink scheduler (0 = open, 1 = closed). */
  setBlinkPulse(value: number): void {
    this.blinkPulse = value;
  }

  update(dt: number): void {
    if (!this.bindings.length) return;
    const lerpRate = 1 - Math.exp(-dt * 11);
    const wanted = new Map(this.target);
    for (const [name, weight] of this.lipSync) {
      wanted.set(name, Math.max(wanted.get(name) ?? 0, weight));
    }
    if (this.blinkPulse > 0) {
      const existing = wanted.get('Fcl_EYE_Close') ?? 0;
      wanted.set('Fcl_EYE_Close', Math.max(existing, this.blinkPulse));
    }
    this.blinkPulse = 0;

    for (const binding of this.bindings) {
      const { dictionary, influences } = binding;
      for (const [morphName, idx] of Object.entries(dictionary)) {
        const goal = wanted.get(morphName) ?? 0;
        const now = this.current.get(morphName) ?? 0;
        let next = now + (goal - now) * lerpRate;
        if (Math.abs(next - goal) < 1e-4) next = goal;
        influences[idx] = next;
        this.current.set(morphName, next);
      }
    }
  }
}
