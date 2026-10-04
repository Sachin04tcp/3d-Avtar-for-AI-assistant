import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'normal' | 'full-body' | 'auto';

interface FrameSpec {
  box: THREE.Box3;
  horizontal: number;
  pitch: number;
}

interface Tween {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  t0: THREE.Vector3;
  t1: THREE.Vector3;
  elapsed: number;
  duration: number;
}

// Scratch vectors — no per-frame allocation.
const _goalPos = new THREE.Vector3();
const _goalTarget = new THREE.Vector3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Camera rig (Phase 2.11/2.12).
 *
 * Framing goals are always computed from the avatar's actual bounds (injected
 * via `frameOf`). Mode 'auto' lets the behavior system switch between normal
 * (face/chest) and full-body (dance) framing; explicit modes pin the camera.
 * Every reframe is a smooth eased tween — never a teleport. User orbiting
 * keeps working: tweens are one-shot, not a per-frame spring.
 */
export class CameraRig {
  mode: CameraMode = 'auto';

  private tween: Tween | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private frameOf: (kind: 'normal' | 'full-body') => FrameSpec,
  ) {}

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === 'auto') this.flyToFrame('normal', 1.1);
    else this.flyToFrame(mode, 1.1);
  }

  /** Called by the behavior system; only acts when the user left mode on auto. */
  applyAuto(desired: 'normal' | 'full-body'): void {
    if (this.mode !== 'auto') return;
    this.flyToFrame(desired, 1.3);
  }

  flyToFrame(kind: 'normal' | 'full-body', duration = 1.1): void {
    this.computeGoal(kind, _goalPos, _goalTarget);
    this.tween = {
      p0: this.camera.position.clone(),
      p1: _goalPos.clone(),
      t0: this.controls.target.clone(),
      t1: _goalTarget.clone(),
      elapsed: 0,
      duration,
    };
  }

  /** Snap instantly (used for the initial frame so the app opens pre-framed). */
  snapToFrame(kind: 'normal' | 'full-body'): void {
    this.computeGoal(kind, _goalPos, _goalTarget);
    this.camera.position.copy(_goalPos);
    this.controls.target.copy(_goalTarget);
    this.controls.update();
    this.tween = null;
  }

  update(dt: number): void {
    const tween = this.tween;
    if (!tween) return;
    tween.elapsed += dt;
    const raw = Math.min(1, tween.elapsed / tween.duration);
    const e = raw * raw * (3 - 2 * raw); // smoothstep
    this.camera.position.lerpVectors(tween.p0, tween.p1, e);
    this.controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (raw >= 1) this.tween = null;
  }

  private computeGoal(kind: 'normal' | 'full-body', outPos: THREE.Vector3, outTarget: THREE.Vector3): void {
    const { box, horizontal, pitch } = this.frameOf(kind);
    const padding = 1.18;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const size = box.getSize(_size);
    const center = box.getCenter(_center);
    const width = Math.max(size.x, size.z * 0.55) * padding;
    const distance = Math.max(
      (size.y * padding) / 2 / Math.tan(fov / 2),
      (width / 2 / Math.tan(fov / 2)) / this.camera.aspect,
    );
    const dir = new THREE.Vector3(horizontal, pitch, 1).normalize();
    outTarget.copy(center);
    outPos.copy(center).addScaledVector(dir, distance);
  }
}
