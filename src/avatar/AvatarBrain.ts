import type { AnimationManager } from './AnimationManager';
import type { BehaviorLayer } from './BehaviorLayer';
import type { Reactions, ReactionName } from './Reactions';
import type { DanceSystem } from './DanceSystem';
import type { CameraRig } from '../core/CameraRig';
import type { EmotionSystem } from './Emotions';
import type { EmotionName } from './Emotions';
import type { LipSyncController, SpeakOptions } from './LipSyncController';

export type AvatarState = 'IDLE' | 'REACTION' | 'SPEAKING' | 'GREETING' | 'DANCE';
export type DanceSource = 'manual' | 'music';

/**
 * AvatarBrain (Phase 2/3/4) — the state/priority machine.
 *
 * Priority: MANUAL COMMAND > DANCE > GREETING > REACTION > SPEAKING > IDLE.
 * Random idle behavior can never interrupt anything (it only runs while state
 * is IDLE). Music-triggered dance is a DANCE whose source is 'music': it
 * interrupts speaking (DANCE > SPEAKING), queues behind GREETING/REACTION, and
 * a manual command (e.g. forced IDLE) suppresses it until the next music
 * state change. While music stays active, dances chain into fresh selections
 * instead of returning to idle; on music stop the current dance gets a short
 * natural ending, then a smooth crossfade back to IDLE. Transitions are always
 * crossfades; the camera follows the state automatically when the rig is in
 * 'auto' mode.
 */
export class AvatarBrain {
  state: AvatarState = 'IDLE';
  danceSource: DanceSource | null = null;
  musicActive = false;
  private musicQueued = false;
  private musicSuppressed = false;
  private elapsed = 0;
  private stateEndsAt = Number.POSITIVE_INFINITY;
  private musicEnergyBand: (() => 'low' | 'medium' | 'high' | null) | null = null;

  constructor(
    private manager: AnimationManager,
    private layer: BehaviorLayer,
    private reactions: Reactions,
    private dances: DanceSystem,
    private emotions: EmotionSystem,
    private cameraRig: CameraRig,
    private lipsync: LipSyncController,
  ) {}

  /** Public API (also the future ANUX seam). */
  trigger(what: 'dance' | 'speak', options?: SpeakOptions): void {
    if (what === 'dance') {
      this.musicSuppressed = false;
      this.enterDance('manual');
    } else this.startSpeaking(options ?? { synthetic: true, syntheticDurationS: 6 });
  }

  /** ANUX seam: music signal from the MusicController / host music system. */
  handleMusicStart(): void {
    this.musicActive = true;
    this.musicSuppressed = false;
    switch (this.state) {
      case 'IDLE':
        this.enterDance('music');
        break;
      case 'SPEAKING':
        // DANCE > SPEAKING: speech yields to music (mouth morphs stop with it)
        this.lipsync.stop();
        this.enterDance('music');
        break;
      case 'REACTION':
      case 'GREETING':
        // let the short reaction/greeting finish, then dance
        this.musicQueued = true;
        break;
      case 'DANCE':
        // manual dance keeps control; music just takes over the chaining
        this.danceSource = 'music';
        break;
    }
  }

  handleMusicEnd(): void {
    this.musicActive = false;
    this.musicQueued = false;
    if (this.state === 'DANCE' && this.danceSource === 'music') {
      // short natural ending, then the normal crossfade to idle
      this.stateEndsAt = Math.min(this.stateEndsAt, this.elapsed + 1.8 + Math.random());
    }
  }

  setState(state: 'IDLE' | 'GREETING' | 'DANCE'): void {
    if (state === 'IDLE') {
      // manual IDLE wins over music dancing until the next music state change
      this.musicSuppressed = this.musicActive;
      this.enterIdle();
    } else if (state === 'GREETING') {
      this.enterGreeting();
    } else {
      this.musicSuppressed = false;
      this.enterDance('manual');
    }
  }

  setEmotion(name: EmotionName): void {
    this.emotions.setEmotion(name);
  }

  react(name: ReactionName): void {
    const allowHead = this.state !== 'DANCE';
    const duration = this.reactions.play(name, allowHead, this.elapsed);
    if (allowHead && this.state === 'IDLE') {
      this.state = 'REACTION';
      this.stateEndsAt = this.elapsed + duration;
    }
  }

  /** Starts speech (viseme timeline primary, audio-analysis fallback). */
  startSpeaking(options: SpeakOptions): void {
    const canHoldState = this.state === 'IDLE' || this.state === 'REACTION';
    this.lipsync.start(options);
    if (canHoldState) {
      this.state = 'SPEAKING';
      this.stateEndsAt = Number.POSITIVE_INFINITY;
      this.manager.backToIdle();
      this.cameraRig.applyAuto('normal');
    }
  }

  stopSpeaking(): void {
    this.lipsync.stop();
    if (this.state === 'SPEAKING') this.enterIdle();
  }

  /** Frame update — runs after the AnimationManager update. */
  update(dt: number): void {
    this.elapsed += dt;
    this.lipsync.update(dt);
    if (this.state === 'SPEAKING' && !this.lipsync.speaking) this.enterIdle();

    const mode = this.state === 'DANCE' || this.state === 'REACTION' || this.state === 'GREETING' ? 'face-only' : 'full';
    this.layer.update(dt, {
      mode,
      scheduler: this.state === 'IDLE',
      speechEnergy: this.lipsync.energy,
    });

    if (this.elapsed >= this.stateEndsAt) {
      if (this.state === 'DANCE') {
        if (this.danceSource === 'music' && this.musicActive) {
          // music still active: chain into a fresh dance selection (variation)
          const band = this.musicEnergyBand?.() ?? undefined;
          const pick = this.dances.pick(band);
          if (pick) {
            this.dances.notePlayed(pick.id);
            this.manager.playAnimation(pick.id);
            this.stateEndsAt = this.elapsed + pick.planned;
          } else this.enterIdle();
        } else this.enterIdle();
      } else if (this.state !== 'IDLE' && this.state !== 'SPEAKING') {
        this.enterIdle();
        // a music start queued behind a greeting/reaction fires now
        if (this.musicQueued && this.musicActive && !this.musicSuppressed) {
          this.musicQueued = false;
          this.enterDance('music');
        }
      }
    }
  }

  /** Energy-band provider from the music detector (used for dance matching). */
  setMusicEnergyBandProvider(provider: () => 'low' | 'medium' | 'high' | null): void {
    this.musicEnergyBand = provider;
  }

  private enterIdle(): void {
    this.state = 'IDLE';
    this.danceSource = null;
    this.stateEndsAt = Number.POSITIVE_INFINITY;
    this.manager.backToIdle();
    this.cameraRig.applyAuto('normal');
  }

  private enterDance(source: DanceSource): void {
    // DANCE outranks everything: even interrupts GREETING/REACTION/SPEAKING.
    const band = source === 'music' ? (this.musicEnergyBand?.() ?? undefined) : undefined;
    const pick = this.dances.pick(band);
    if (!pick) return;
    this.dances.notePlayed(pick.id);
    this.manager.playAnimation(pick.id);
    this.danceSource = source;
    this.musicQueued = false;
    this.state = 'DANCE';
    this.stateEndsAt = this.elapsed + pick.planned;
    this.cameraRig.applyAuto('full-body');
  }

  private enterGreeting(): void {
    if (this.state === 'DANCE') return; // DANCE > GREETING
    this.lipsync.stop(); // greeting interrupts speech
    this.state = 'GREETING';
    const duration = this.reactions.play('GREETING', true, this.elapsed);
    this.stateEndsAt = this.elapsed + duration;
  }
}
