export interface DanceCandidate {
  id: string;
  category: string;
  duration: number;
  /** measured motion energy from the registry (rad/s across arms/spine/legs) */
  energy: number;
}

export interface DancePick {
  id: string;
  loops: number;
  /** total seconds to stay in the dance state (loop count × clip duration) */
  planned: number;
}

/**
 * Weighted dance selection (Phase 2/4).
 *
 * Candidates come from the animation registry's measured DANCE category. The
 * two most recently played dances are heavily down-weighted, so sequences like
 * A → B → C → A happen naturally while A → A → A cannot. When the music
 * system provides an energy band, selection is biased toward a matching
 * motion energy (relaxed / normal / energetic) — never exaggerated, selection
 * bias only.
 */
export class DanceSystem {
  private candidates: DanceCandidate[];
  private history: string[] = [];

  constructor(clips: DanceCandidate[]) {
    this.candidates = clips.filter((c) => c.category === 'DANCE');
  }

  get availableIds(): string[] {
    return this.candidates.map((c) => c.id);
  }

  pick(targetEnergy?: 'low' | 'medium' | 'high'): DancePick | null {
    if (!this.candidates.length) return null;
    const recent = new Set(this.history.slice(-2));

    let total = 0;
    const weights = this.candidates.map((c) => {
      const w = (recent.has(c.id) ? 0.12 : 1) * this.energyFit(c.energy, targetEnergy);
      total += w;
      return w;
    });
    let roll = Math.random() * total;
    let chosen = this.candidates[this.candidates.length - 1];
    for (let i = 0; i < this.candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = this.candidates[i]; break; }
    }

    const loops = chosen.duration < 4 ? (Math.random() < 0.4 ? 3 : 2) : Math.random() < 0.4 ? 2 : 1;
    return { id: chosen.id, loops, planned: chosen.duration * loops };
  }

  private energyFit(energy: number, target?: 'low' | 'medium' | 'high'): number {
    if (target === 'low') return 1.6 / (0.6 + energy);
    if (target === 'medium') return 1.2 / (0.5 + Math.abs(energy - 1.8));
    if (target === 'high') return 0.6 + energy / 1.8;
    return 1;
  }

  notePlayed(id: string): void {
    this.history.push(id);
    if (this.history.length > 6) this.history.shift();
  }
}
