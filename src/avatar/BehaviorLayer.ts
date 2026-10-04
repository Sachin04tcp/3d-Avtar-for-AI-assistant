import * as THREE from 'three';
import type { EmotionSystem } from './Emotions';

export interface BehaviorToggles {
  idle: boolean;
  blink: boolean;
  eyes: boolean;
  head: boolean;
}

export interface BehaviorBones {
  hips: THREE.Bone | null;
  upperChest: THREE.Bone | null;
  neck: THREE.Bone | null;
  head: THREE.Bone | null;
  shoulderL: THREE.Bone | null;
  shoulderR: THREE.Bone | null;
  eyeL: THREE.Bone | null;
  eyeR: THREE.Bone | null;
}

interface Gaze {
  yaw: number;
  pitch: number;
}

interface BehaviorDef {
  weight: number;
  cooldownS: number;
  minGapS?: number;
  run: (self: BehaviorLayer) => void;
}

// Scratch objects — reused every frame, no per-frame allocation.
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Procedural "alive" layer (Phase 2).
 *
 * Adds breathing, body sway, weight shifts, gaze (head + eye micro-rotation),
 * head micro-motion, and a weighted randomized behavior scheduler (double
 * blinks, smile flickers, curious tilts, nods, shrugs, looking away...) on top
 * of whatever the AnimationMixer is playing.
 *
 * The layer only ever runs while the idle clip is the active animation, so it
 * can never fight dances/reactions. Offsets are applied AFTER the mixer update
 * each frame (the mixer rewrites the base pose, so nothing accumulates).
 */
export class BehaviorLayer {
  toggles: BehaviorToggles = { idle: true, blink: true, eyes: true, head: true };

  /** Reactions write here to temporarily drive gaze/head with priority. */
  override: { gaze?: Gaze; headPitch?: number; headYaw?: number; headRoll?: number; until: number } | null = null;

  private clock = 0;
  private breathPhase = 0;
  private breathEnvelope = 1;

  // blink scheduling
  private nextBlinkAt = rand(1.2, 3);
  private blinkPhase = -1;
  private pendingDoubleBlink = false;

  // gaze
  private gaze: Gaze = { yaw: 0, pitch: 0 };
  private gazeTarget: Gaze = { yaw: 0, pitch: 0 };
  private gazeHoldUntil = 0;
  private nextSaccadeAt = 0;
  private gazeIsCamera = true;

  // posture / weight shift
  private weightShift = new THREE.Vector2();
  private weightShiftTarget = new THREE.Vector2();
  private nextShiftAt = rand(6, 12);

  // shrug timeline
  private shrugPhase = -1;

  // behavior scheduler
  private nextBehaviorAt = rand(2, 4.5);
  private activeUntil = 0;
  private history: string[] = [];
  private cooldowns = new Map<string, number>();

  // continuous head noise seeds (irrational ratios → never visibly repeats)
  private readonly noiseSeeds = [1.7, 3.9, 6.1, 8.3];

  constructor(
    private emotions: EmotionSystem,
    private engine: { setBlinkPulse(v: number): void },
    private bones: BehaviorBones,
    private getCamera: () => THREE.Camera,
  ) {}

  get overrideActive(): boolean {
    return this.override !== null && this.clock < this.override.until;
  }

  /**
   * @param opts.mode 'full'    = idle-style procedural body + head + gaze (IDLE/SPEAKING)
   *                    'face-only' = reaction/greeting cues only (GREETING/REACTION/DANCE)
   *                    'off'       = nothing (dev panel stop/reset)
   * @param opts.scheduler  random idle behaviors allowed (IDLE only — never during speech)
   * @param opts.speechEnergy 0..1 mouth energy from the LipSyncController; drives
   *                          subtle emphasis nods and occasional tilts while speaking
   */
  update(dt: number, opts: { mode: 'full' | 'face-only' | 'off'; scheduler: boolean; speechEnergy: number }): void {
    this.clock += dt;
    const p = this.emotions.params;

    this.updateBlink(dt, p.blinkRateMul);

    // Reaction overrides must apply even outside idle (but never body sway —
    // that stays exclusive to the idle clip so dances are never fought over).
    const overrideNow = this.overrideActive;
    const running = opts.mode === 'full' && this.toggles.idle;
    const headOn = (opts.mode === 'full' || (opts.mode === 'face-only' && overrideNow)) && this.toggles.head;
    if (running) this.updateBody(dt, p.breathRate);
    this.updateSpeechMotion(dt, opts.speechEnergy, running);
    this.updateGaze(dt, p.gazeCameraBias, running || overrideNow);
    if (headOn) this.applyHead(dt, p.headPitchBiasDeg);
    if (running) this.applyBodyOffsets(p.swayEnergy);
    if (running && opts.scheduler) this.updateScheduler(p.behaviorEnergy);
  }

  // ------------------------------------------------------- speech emphasis

  private smoothedSpeech = 0;
  private prevSpeech = 0;
  private nextSpeechNodAt = 0;
  private nextSpeechTiltAt = 0;
  private speechTiltResetAt = 0;
  private nodAmplitude = 3.2;

  private updateSpeechMotion(dt: number, energy: number, running: boolean): void {
    const k = 1 - Math.exp(-dt * 8);
    this.prevSpeech = this.smoothedSpeech;
    this.smoothedSpeech += (energy - this.smoothedSpeech) * k;
    if (!running) return;

    // emphasis nod on syllable-energy peaks (subtle: ~1.6°)
    if (
      this.smoothedSpeech > 0.35 &&
      this.smoothedSpeech > this.prevSpeech * 1.1 &&
      this.clock >= this.nextSpeechNodAt &&
      this.nodPhase < 0
    ) {
      this.nextSpeechNodAt = this.clock + rand(0.5, 1.4);
      this.nodAmplitude = 1.6;
      this.nodPhase = 0;
    }

    // occasional slight tilt while talking
    if (this.smoothedSpeech > 0.12 && this.clock >= this.nextSpeechTiltAt) {
      this.nextSpeechTiltAt = this.clock + rand(3.2, 7.5);
      this.speechTiltResetAt = this.clock + rand(1.4, 2.6);
      this.tiltTarget = rand(0.04, 0.08) * (Math.random() < 0.5 ? -1 : 1);
    }
    if (this.speechTiltResetAt && this.clock >= this.speechTiltResetAt) {
      this.speechTiltResetAt = 0;
      this.tiltTarget = 0;
    }
  }

  // ---------------------------------------------------------------- blink

  private updateBlink(dt: number, rateMul: number): void {
    if (!this.toggles.blink) {
      this.engine.setBlinkPulse(0);
      this.blinkPhase = -1;
      return;
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt / 0.13;
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        if (this.pendingDoubleBlink) {
          this.pendingDoubleBlink = false;
          this.nextBlinkAt = this.clock + rand(0.14, 0.24); // second blink of a double
        } else {
          this.nextBlinkAt = this.clock + rand(2.6, 6.4) / Math.max(0.3, rateMul);
        }
      }
    } else if (this.clock >= this.nextBlinkAt) {
      this.blinkPhase = 0;
      this.pendingDoubleBlink = Math.random() < 0.12;
    }
    const pulse = this.blinkPhase >= 0 ? Math.sin(Math.PI * Math.min(1, this.blinkPhase)) : 0;
    this.engine.setBlinkPulse(pulse);
  }

  // ------------------------------------------------------------ body/procedural

  private updateBody(dt: number, breathRate: number): void {
    this.breathPhase += dt * Math.PI * 2 * Math.max(0.08, breathRate);
    // breathing depth envelope: occasional deeper breath
    if (Math.random() < dt * 0.06) this.breathEnvelope = rand(1.4, 2.1);
    this.breathEnvelope += (1 - this.breathEnvelope) * (1 - Math.exp(-dt * 0.5));

    // weight shift re-targeting — random, never periodic
    if (this.clock >= this.nextShiftAt) {
      this.nextShiftAt = this.clock + rand(8, 18);
      this.weightShiftTarget.set(rand(-0.008, 0.008), rand(-0.004, 0.004));
    }
    const k = 1 - Math.exp(-dt * 0.7);
    this.weightShift.lerp(this.weightShiftTarget, k);

    // shrug timeline (allocation-free, driven by the frame clock)
    if (this.shrugPhase >= 0) {
      this.shrugPhase += dt / 1.6;
      if (this.shrugPhase >= 1) this.shrugPhase = -1;
    }
  }

  private applyBodyOffsets(swayEnergy: number): void {
    const t = this.clock;
    const breath = Math.sin(this.breathPhase) * 0.5 * this.breathEnvelope;

    const chest = this.bones.upperChest;
    if (chest) {
      _e.set(THREE.MathUtils.degToRad(breath * 0.55), 0, 0);
      chest.quaternion.multiply(_q.setFromEuler(_e));
    }
    const hips = this.bones.hips;
    if (hips) {
      // slow figure-eight weight sway + the randomized weight shift
      const swayYaw = (Math.sin(t * 0.31 * Math.PI + this.noiseSeeds[0]) * 0.35 + Math.sin(t * 0.13 * Math.PI + this.noiseSeeds[1]) * 0.22) * swayEnergy;
      const swayRoll = Math.sin(t * 0.23 * Math.PI + this.noiseSeeds[2]) * 0.3 * swayEnergy;
      _e.set(0, THREE.MathUtils.degToRad(swayYaw), THREE.MathUtils.degToRad(swayRoll));
      hips.quaternion.multiply(_q.setFromEuler(_e));
      hips.position.x += this.weightShift.x;
      hips.position.z += this.weightShift.y;
      hips.position.y += breath * 0.0012;
    }
    const shoulderL = this.bones.shoulderL;
    const shoulderR = this.bones.shoulderR;
    if (shoulderL && shoulderR) {
      const rise = THREE.MathUtils.degToRad(breath * 0.4);
      if (this.shrugPhase >= 0) {
        const shrug = Math.sin(Math.PI * this.shrugPhase) * 2.2;
        _e.set(0, 0, rise + THREE.MathUtils.degToRad(shrug));
        shoulderL.quaternion.multiply(_q.setFromEuler(_e));
        _e.set(0, 0, -(rise + THREE.MathUtils.degToRad(shrug)));
        shoulderR.quaternion.multiply(_q.setFromEuler(_e));
      } else {
        _e.set(0, 0, rise);
        shoulderL.quaternion.multiply(_q.setFromEuler(_e));
        _e.set(0, 0, -rise);
        shoulderR.quaternion.multiply(_q.setFromEuler(_e));
      }
    }
  }

  // ------------------------------------------------------------------ gaze

  private updateGaze(dt: number, cameraBias: number, running: boolean): void {
    const now = this.clock;
    if (this.overrideActive && this.override!.gaze) {
      this.gazeTarget.yaw = this.override!.gaze.yaw;
      this.gazeTarget.pitch = this.override!.gaze.pitch;
    } else if (!running) {
      this.gazeTarget.yaw = 0;
      this.gazeTarget.pitch = 0;
    } else if (now >= this.gazeHoldUntil) {
      // choose a new gaze goal: mostly the camera, sometimes wandering
      const cam = this.getCamera();
      const head = this.bones.head;
      let yaw = 0;
      let pitch = 0;
      if (head) {
        head.getWorldPosition(_v);
        const dx = cam.position.x - _v.x;
        const dy = cam.position.y - _v.y;
        const dz = cam.position.z - _v.z;
        if (Math.random() < cameraBias) {
          yaw = Math.atan2(dx, dz) * rand(0.55, 0.95);
          pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * rand(0.5, 0.9);
        } else {
          yaw = rand(-0.38, 0.38);
          pitch = rand(-0.22, 0.18);
        }
        this.gazeIsCamera = true;
      }
      this.gazeHoldUntil = now + rand(1.6, 4.6);
      this.gazeTarget.yaw = yaw;
      this.gazeTarget.pitch = pitch;
    } else if (now >= this.nextSaccadeAt && this.gazeIsCamera) {
      // tiny saccade jitter while looking at the camera
      this.nextSaccadeAt = now + rand(0.8, 3.2);
      this.gazeTarget.yaw += rand(-0.03, 0.03);
      this.gazeTarget.pitch += rand(-0.02, 0.02);
    }

    const k = 1 - Math.exp(-dt * 7);
    this.gaze.yaw += (this.gazeTarget.yaw - this.gaze.yaw) * k;
    this.gaze.pitch += (this.gazeTarget.pitch - this.gaze.pitch) * k;
  }

  // ------------------------------------------------------------------ head

  private tiltTarget = 0;
  private tilt = 0;
  private nodPhase = -1;
  private nodValue = 0;

  private applyHead(dt: number, pitchBiasDeg: number): void {
    const t = this.clock;
    const neck = this.bones.neck;
    const head = this.bones.head;
    const eyesOn = this.toggles.eyes;
    const headOn = this.toggles.head;

    // smooth tilt easing
    this.tilt += (this.tiltTarget - this.tilt) * (1 - Math.exp(-dt * 3));
    if (this.nodPhase >= 0) {
      this.nodPhase += dt / 0.9;
      this.nodValue = this.nodPhase >= 1 ? 0 : Math.sin(this.nodPhase * Math.PI * 2) * this.nodAmplitude;
      if (this.nodPhase >= 1) this.nodPhase = -1;
    }

    const ov = this.overrideActive ? this.override! : null;
    const noiseYaw = (Math.sin(t * 0.47 * Math.PI + this.noiseSeeds[3]) * 0.5 + Math.sin(t * 0.83 * Math.PI + this.noiseSeeds[0]) * 0.3);
    const microYaw = THREE.MathUtils.degToRad(noiseYaw * 0.9) + (ov?.headYaw ?? 0);
    const microPitch = THREE.MathUtils.degToRad(noiseYaw * 0.35) + THREE.MathUtils.degToRad(pitchBiasDeg) + THREE.MathUtils.degToRad(this.nodValue) + (ov?.headPitch ?? 0);
    const roll = THREE.MathUtils.degToRad(noiseYaw * 0.25) + this.tilt + (ov?.headRoll ?? 0);

    const yawNow = this.gaze.yaw + microYaw;
    const pitchNow = this.gaze.pitch + microPitch;

    if (headOn) {
      const k = 1 - Math.exp(-dt * 6);
      this.appliedYaw += (yawNow - this.appliedYaw) * k;
      this.appliedPitch += (pitchNow - this.appliedPitch) * k;
      if (neck) {
        _e.set(this.appliedPitch * 0.4, this.appliedYaw * 0.4, roll * 0.4);
        neck.quaternion.multiply(_q.setFromEuler(_e));
      }
      if (head) {
        _e.set(this.appliedPitch * 0.6, this.appliedYaw * 0.6, roll * 0.6);
        head.quaternion.multiply(_q.setFromEuler(_e));
      }
    } else {
      this.appliedYaw *= 0.9;
      this.appliedPitch *= 0.9;
    }

    // eyes take the gaze residual the head did not cover (clamped, subtle).
    // The mixer never rewrites these adjust bones, so the previous frame's
    // offset must be removed before applying the new one (no accumulation).
    if (eyesOn && (this.bones.eyeL || this.bones.eyeR)) {
      const residualYaw = THREE.MathUtils.clamp((this.gaze.yaw - this.appliedYaw) * 0.5, -0.09, 0.09);
      const residualPitch = THREE.MathUtils.clamp((this.gaze.pitch - this.appliedPitch) * 0.5, -0.05, 0.05);
      _e.set(residualPitch, residualYaw, 0);
      _q.setFromEuler(_e);
      this.applyUntrackedOffset(this.bones.eyeL, _q);
      this.applyUntrackedOffset(this.bones.eyeR, _q);
    } else if (!eyesOn && this.eyeOffsets.size) {
      for (const [bone, prev] of this.eyeOffsets) {
        _q.copy(prev).invert();
        bone.quaternion.multiply(_q);
      }
      this.eyeOffsets.clear();
    }
  }

  private eyeOffsets = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly _q2 = new THREE.Quaternion();

  private applyUntrackedOffset(bone: THREE.Bone | null, offset: THREE.Quaternion): void {
    if (!bone) return;
    let prev = this.eyeOffsets.get(bone);
    if (!prev) {
      prev = new THREE.Quaternion();
      this.eyeOffsets.set(bone, prev);
    }
    this._q2.copy(prev).invert();
    bone.quaternion.multiply(this._q2).multiply(offset);
    prev.copy(offset);
  }
  private appliedYaw = 0;
  private appliedPitch = 0;

  // ------------------------------------------------------------- scheduler

  private updateScheduler(energy: number): void {
    if (this.overrideActive || this.clock < this.activeUntil || this.clock < this.nextBehaviorAt) return;

    const available = BEHAVIORS.filter((b) => (this.cooldowns.get(b.name) ?? 0) <= this.clock);
    if (!available.length) return;
    let total = 0;
    const weights = available.map((b) => {
      const recent = this.history.indexOf(b.name);
      const w = b.weight * (recent >= 0 ? Math.pow(0.15, this.history.length - recent) : 1);
      total += w;
      return w;
    });
    let roll = Math.random() * total;
    let chosen = available[available.length - 1];
    for (let i = 0; i < available.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = available[i]; break; }
    }

    chosen.run(this);
    this.history.push(chosen.name);
    if (this.history.length > 4) this.history.shift();
    this.cooldowns.set(chosen.name, this.clock + chosen.cooldownS * rand(0.8, 1.25));
    this.activeUntil = this.clock + (chosen.minGapS ?? 1);
    this.nextBehaviorAt = this.clock + rand(2.8, 6.8) / Math.max(0.3, energy);
  }

  // ------------------------------------------------------- behavior actions

  // ------------------------------------------------------- reaction cues

  /** Immediate nod cue (used by the GREETING reaction). */
  nodNow(): void {
    this.nodAmplitude = 3.2;
    this.nodPhase = 0;
  }

  /** Immediate blink cue (used by reactions). */
  blinkNow(): void {
    this.nextBlinkAt = this.clock;
  }

  lookAway(): void {
    const yaw = rand(0.3, 0.65) * (Math.random() < 0.5 ? -1 : 1);
    const pitch = rand(-0.18, 0.1);
    this.override = { gaze: { yaw, pitch }, until: this.clock + rand(1.6, 3.2) };
  }

  curiousTilt(): void {
    this.tiltTarget = rand(0.07, 0.13) * (Math.random() < 0.5 ? -1 : 1);
    setTimeout(() => { this.tiltTarget = 0; }, rand(1800, 3200));
  }

  smileFlicker(): void {
    this.emotions.setOverlay([['Fcl_MTH_Fun', 0.45], ['Fcl_EYE_Joy', 0.3]], rand(1.6, 2.8));
  }

  thinkingMoment(): void {
    const yaw = rand(0.3, 0.55) * (Math.random() < 0.5 ? -1 : 1);
    this.override = { gaze: { yaw, pitch: 0.14 }, headRoll: rand(-0.05, 0.05), until: this.clock + rand(2.2, 3.8) };
    this.emotions.setOverlay([['Fcl_BRW_Sorrow', 0.4], ['Fcl_MTH_Small', 0.5]], rand(2.2, 3.8));
  }

  nodNowInternal(): void {
    this.nodPhase = 0;
  }

  shrug(): void {
    this.shrugPhase = 0;
  }

  playfulTilt(): void {
    this.tiltTarget = rand(0.1, 0.16) * (Math.random() < 0.5 ? -1 : 1);
    this.emotions.setOverlay([['Fcl_MTH_Fun', 0.3]], rand(1.4, 2.4));
    setTimeout(() => { this.tiltTarget = 0; }, rand(1400, 2400));
  }

  doubleBlink(): void {
    this.pendingDoubleBlink = true;
    this.nextBlinkAt = this.clock;
  }

  lookDown(): void {
    this.override = { gaze: { yaw: rand(-0.15, 0.15), pitch: 0.22 }, until: this.clock + rand(1.4, 2.6) };
  }
}

interface BehaviorSpec extends BehaviorDef {
  name: string;
}

const BEHAVIORS: BehaviorSpec[] = [
  { name: 'look-away', weight: 1.4, cooldownS: 18, run: (s) => s.lookAway() },
  { name: 'smile-flicker', weight: 1.3, cooldownS: 14, run: (s) => s.smileFlicker() },
  { name: 'double-blink', weight: 0.9, cooldownS: 12, run: (s) => s.doubleBlink() },
  { name: 'curious-tilt', weight: 1.0, cooldownS: 22, run: (s) => s.curiousTilt() },
  { name: 'nod', weight: 0.8, cooldownS: 26, run: (s) => s.nodNowInternal() },
  { name: 'thinking-moment', weight: 0.8, cooldownS: 30, run: (s) => s.thinkingMoment() },
  { name: 'shrug', weight: 0.55, cooldownS: 34, run: (s) => s.shrug() },
  { name: 'playful-tilt', weight: 0.7, cooldownS: 28, run: (s) => s.playfulTilt() },
  { name: 'look-down', weight: 0.7, cooldownS: 20, run: (s) => s.lookDown() },
];
