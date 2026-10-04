import type { BehaviorLayer } from './BehaviorLayer';
import type { EmotionSystem } from './Emotions';

export type ReactionName = 'GREETING' | 'SURPRISED' | 'HAPPY' | 'SAD' | 'ANGRY' | 'THINKING';

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Choreographed micro-reactions (Phase 2.8).
 *
 * A reaction is a short timeline of cues (gaze holds, head nudges, emotion
 * overlays) played on top of whatever state the avatar is in. Body/head cues
 * are skipped when the avatar is dancing — only the face reacts then.
 * `now` is the shared behavior clock (seconds).
 */
export class Reactions {
  constructor(
    private layer: BehaviorLayer,
    private emotions: EmotionSystem,
  ) {}

  /** Starts a reaction; returns its duration in seconds. */
  play(name: ReactionName, allowHead: boolean, now: number): number {
    switch (name) {
      case 'GREETING': {
        // look at the camera, smile, double-blink, small nod + tilt
        if (allowHead) {
          this.layer.override = { gaze: { yaw: 0, pitch: -0.04 }, headPitch: -1.5, until: now + rand(2.2, 2.8) };
          this.layer.nodNow();
        }
        this.emotions.setOverlay(
          [
            ['Fcl_ALL_Joy', 0.55],
            ['Fcl_MTH_Fun', 0.35],
            ['Fcl_EYE_Spread', 0.2],
          ],
          rand(2.2, 2.8),
        );
        this.layer.blinkNow();
        return 2.6;
      }
      case 'SURPRISED': {
        // sharp intake: eyes widen, head pulls back a touch
        if (allowHead) {
          this.layer.override = {
            gaze: { yaw: rand(-0.1, 0.1), pitch: -0.1 },
            headPitch: -3,
            until: now + rand(1.1, 1.5),
          };
        }
        this.emotions.setOverlay(
          [
            ['Fcl_ALL_Surprised', 0.85],
            ['Fcl_EYE_Spread', 0.8],
            ['Fcl_MTH_Small', 0.5],
          ],
          rand(1.2, 1.6),
        );
        this.layer.blinkNow();
        return 1.5;
      }
      case 'HAPPY': {
        this.emotions.setEmotion('HAPPY');
        this.emotions.setOverlay([['Fcl_MTH_Joy', 0.5], ['Fcl_EYE_Spread', 0.25]], 1.6);
        return 1.6;
      }
      case 'SAD': {
        this.emotions.setEmotion('SAD');
        if (allowHead) {
          this.layer.override = { gaze: { yaw: rand(-0.15, 0.15), pitch: 0.1 }, headPitch: 3, until: now + 2 };
        }
        return 2;
      }
      case 'ANGRY': {
        this.emotions.setEmotion('ANGRY');
        if (allowHead) {
          this.layer.override = { gaze: { yaw: 0, pitch: 0.05 }, headPitch: 1.5, until: now + 1.6 };
        }
        return 1.6;
      }
      case 'THINKING': {
        this.emotions.setEmotion('THINKING');
        if (allowHead) {
          this.layer.override = {
            gaze: { yaw: rand(0.25, 0.45) * (Math.random() < 0.5 ? -1 : 1), pitch: 0.12 },
            headRoll: rand(-0.06, 0.06),
            until: now + rand(2.2, 3.2),
          };
        }
        return 2.6;
      }
    }
  }
}
