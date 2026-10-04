import * as THREE from 'three';
import { CROSSFADE_S, ONESHOT_HOLD_MS } from '../config';
import type { ClipBuildResult } from './ClipLibrary';

export type LoopMode = 'default' | 'loop' | 'once';

export interface ManagedClipInfo {
  id: string;
  label: string;
  category: string;
  kind: 'loop' | 'once';
  duration: number;
}

interface Entry {
  action: THREE.AnimationAction;
  info: ManagedClipInfo;
  loopOverride: LoopMode;
}

/**
 * Central animation state machine (Phase 7).
 *
 * Owns the AnimationMixer and guarantees a single animation drives the bones at
 * a time: switching clips crossfades the outgoing action out and the incoming
 * one in; Stop fades the active action out entirely (which blends the pose back
 * to the state captured when the mixer bound the bones — the rest pose, see the
 * constructor priming); Reset restores the saved rest pose immediately.
 */
export class AnimationManager {
  readonly mixer: THREE.AnimationMixer;
  readonly clips = new Map<string, Entry>();
  readonly idleId: string;

  private _currentId: string | null = null;
  private _onCurrentChanged?: (id: string | null) => void;
  private returnTimer: ReturnType<typeof setTimeout> | null = null;
  private restPose: Array<{ bone: THREE.Bone; pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }> = [];

  constructor(root: THREE.Object3D, clips: ClipBuildResult[], idleId: string) {
    this.mixer = new THREE.AnimationMixer(root);
    this.idleId = idleId;

    for (const bone of root.getObjectsByProperty('isBone', true) as unknown as THREE.Bone[]) {
      this.restPose.push({ bone, pos: bone.position.clone(), quat: bone.quaternion.clone(), scale: bone.scale.clone() });
    }

    for (const clip of clips) {
      const info: ManagedClipInfo = {
        id: clip.id,
        label: clip.label,
        category: clip.category,
        kind: clip.kind,
        duration: clip.clip.duration,
      };
      const action = this.mixer.clipAction(clip.clip);
      this.applyLoopMode(action, info, 'default');
      this.clips.set(clip.id, { action, info, loopOverride: 'default' });
    }

    this.mixer.addEventListener('finished', (event) => {
      const action = (event as { action: THREE.AnimationAction }).action;
      const entry = [...this.clips.values()].find((e) => e.action === action);
      if (!entry || entry.info.id === this.idleId) return;
      if (this.effectiveKind(entry) !== 'once') return;
      this.scheduleReturnToIdle(ONESHOT_HOLD_MS);
    });

    const idle = this.clips.get(idleId);
    if (!idle) throw new Error(`Idle clip "${idleId}" missing from built clips`);

    // Prime every PropertyBinding while the bones are still at rest, so fades
    // toward zero weight blend back to the rest pose rather than a mid-clip pose.
    for (const entry of this.clips.values()) {
      entry.action.play();
      entry.action.setEffectiveWeight(0);
    }
    this.mixer.update(0);
    for (const entry of this.clips.values()) entry.action.stop();

    idle.action.reset().setEffectiveWeight(1).play();
    this._currentId = idleId;
  }

  get currentId(): string | null {
    return this._currentId;
  }

  get nowPlaying(): { id: string; label: string } | null {
    return this._currentId ? { id: this._currentId, label: this.clips.get(this._currentId)!.info.label } : null;
  }

  onCurrentChanged(cb: (id: string | null) => void): void {
    this._onCurrentChanged = cb;
  }

  /** Crossfades to the given clip (the standard way to switch animations). */
  playAnimation(id: string, fade: number = CROSSFADE_S): void {
    const entry = this.clips.get(id);
    if (!entry) return;
    this.clearReturnTimer();

    if (this._currentId === id) {
      // Re-triggering the active one-shot restarts it; active loops keep playing.
      if (this.effectiveKind(entry) === 'once') entry.action.reset().play();
      return;
    }

    const prev = this._currentId ? this.clips.get(this._currentId) : null;
    this.applyLoopMode(entry.action, entry.info, entry.loopOverride);
    entry.action.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev) prev.action.fadeOut(fade);
    this._currentId = id;
    this._onCurrentChanged?.(id);
  }

  /** Alias with the explicit crossfade name from the phase spec. */
  crossFadeTo(id: string, fade: number = CROSSFADE_S): void {
    this.playAnimation(id, fade);
  }

  /** Fades the active animation out; the pose blends back to rest. */
  stopAnimation(fade: number = CROSSFADE_S): void {
    this.clearReturnTimer();
    const entry = this._currentId ? this.clips.get(this._currentId) : null;
    if (entry) entry.action.fadeOut(fade);
    this._currentId = null;
    this._onCurrentChanged?.(null);
  }

  /** Stops everything and snaps every bone back to its saved rest pose. */
  resetAnimation(): void {
    this.clearReturnTimer();
    this.mixer.stopAllAction();
    for (const rest of this.restPose) {
      rest.bone.position.copy(rest.pos);
      rest.bone.quaternion.copy(rest.quat);
      rest.bone.scale.copy(rest.scale);
    }
    this._currentId = null;
    this._onCurrentChanged?.(null);
  }

  /** Override loop/once for a clip ('default' = registry classification). */
  setLoopMode(mode: LoopMode, id?: string): void {
    const target = id ?? this._currentId;
    if (!target) return;
    const entry = this.clips.get(target);
    if (!entry) return;
    entry.loopOverride = mode;
    this.applyLoopMode(entry.action, entry.info, mode);
  }

  getLoopOverride(id: string): LoopMode {
    return this.clips.get(id)?.loopOverride ?? 'default';
  }

  /** Returns to the idle clip (used after one-shots and by the UI button). */
  backToIdle(fade: number = CROSSFADE_S): void {
    if (this._currentId !== this.idleId) this.playAnimation(this.idleId, fade);
  }

  setSpeed(mult: number): void {
    this.mixer.timeScale = mult;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  private effectiveKind(entry: Entry): 'loop' | 'once' {
    return entry.loopOverride === 'default' ? entry.info.kind : entry.loopOverride;
  }

  private applyLoopMode(action: THREE.AnimationAction, info: ManagedClipInfo, mode: LoopMode): void {
    const kind = mode === 'default' ? info.kind : mode;
    action.setLoop(kind === 'once' ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = kind === 'once';
  }

  private scheduleReturnToIdle(ms: number): void {
    this.clearReturnTimer();
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      if (this._currentId !== this.idleId && this._currentId !== null) this.playAnimation(this.idleId);
    }, ms);
  }

  private clearReturnTimer(): void {
    if (this.returnTimer !== null) {
      clearTimeout(this.returnTimer);
      this.returnTimer = null;
    }
  }
}
