import './style.css';
import * as THREE from 'three';
import { SceneManager } from './core/SceneManager';
import { CameraRig } from './core/CameraRig';
import type { CameraMode } from './core/CameraRig';
import { loadAvatar } from './avatar/AvatarLoader';
import { buildClips } from './avatar/ClipLibrary';
import { AnimationManager } from './avatar/AnimationManager';
import type { LoopMode } from './avatar/AnimationManager';
import { ExpressionEngine } from './avatar/Expressions';
import { EmotionSystem } from './avatar/Emotions';
import { BehaviorLayer } from './avatar/BehaviorLayer';
import type { BehaviorBones } from './avatar/BehaviorLayer';
import { Reactions } from './avatar/Reactions';
import { DanceSystem } from './avatar/DanceSystem';
import { AvatarBrain } from './avatar/AvatarBrain';
import { LipSyncController } from './avatar/LipSyncController';
import { MusicActivityDetector } from './avatar/MusicActivityDetector';
import { MusicController } from './avatar/MusicController';
import { UIController } from './ui/UIController';
import type { InfoRow, UIStateCommand } from './ui/UIController';
import { LoadingUI } from './ui/LoadingUI';
import {
  BONE_MAP,
  CLIP_SOURCES,
  IDLE_CLIP_ID,
  IN_PLACE_ROOT_MOTION,
  MODEL_LABEL,
  MODEL_URL,
  RETARGET_SAMPLE_FPS,
} from './config';
import type { EmotionName } from './avatar/Emotions';

void boot();

async function boot(): Promise<void> {
  const loading = new LoadingUI();
  const stage = document.getElementById('stage')!;
  const sceneManager = new SceneManager(stage);
  loading.setProgress(0.05, 'Loading avatar model…');

  try {
    const avatar = await loadAvatar(MODEL_URL, (f) => loading.setProgress(0.05 + f * 0.45, 'Loading avatar model…'));
    sceneManager.scene.add(avatar.root);
    document.getElementById('model-subtitle')!.textContent = `${MODEL_LABEL} · ${avatar.height.toFixed(2)} m`;

    loading.setProgress(0.5, 'Retargeting Mixamo clips…');
    const clips = await buildClips(
      CLIP_SOURCES,
      avatar.root,
      { boneMap: new Map(Object.entries(BONE_MAP)), sampleFps: RETARGET_SAMPLE_FPS, inPlace: IN_PLACE_ROOT_MOTION },
      (done, total, label) => loading.setProgress(0.5 + (done / total) * 0.45, `Retargeting ${label} (${done + 1}/${total})…`),
    );

    const manager = new AnimationManager(avatar.root, clips, IDLE_CLIP_ID);
    const engine = new ExpressionEngine(avatar.morphMeshes);
    const emotions = new EmotionSystem(engine);

    const bone = (name: string) => (avatar.root.getObjectByName(name) as THREE.Bone | undefined) ?? null;
    const behaviorBones: BehaviorBones = {
      hips: bone('J_Bip_C_Hips'),
      upperChest: bone('J_Bip_C_UpperChest'),
      neck: bone('J_Bip_C_Neck'),
      head: bone('J_Bip_C_Head'),
      shoulderL: bone('J_Bip_L_Shoulder'),
      shoulderR: bone('J_Bip_R_Shoulder'),
      eyeL: bone('J_Adj_L_FaceEye'),
      eyeR: bone('J_Adj_R_FaceEye'),
    };

    const layer = new BehaviorLayer(emotions, engine, behaviorBones, () => sceneManager.camera);
    const reactions = new Reactions(layer, emotions);
    const dances = new DanceSystem(clips.map((c) => ({ id: c.id, category: c.category, duration: c.clip.duration, energy: c.energy })));

    // ---- camera framing from the avatar's actual bounds (Phase 2.12) ----
    const frameOf = (kind: 'normal' | 'full-body') => {
      const box = new THREE.Box3().setFromObject(avatar.root);
      const size = box.getSize(new THREE.Vector3());
      if (kind === 'normal') {
        // FACE + HEAD + CHEST + UPPER BODY: anchored on the real head-bone height.
        const head = bone('J_Bip_C_Head');
        const headY = head ? head.getWorldPosition(new THREE.Vector3()).y : box.min.y + size.y * 0.9;
        const top = box.max.y + size.y * 0.03;
        const bottom = headY - 0.5 * (headY - box.min.y);
        return {
          box: new THREE.Box3(new THREE.Vector3(box.min.x, bottom, box.min.z), new THREE.Vector3(box.max.x, top, box.max.z)),
          horizontal: 0.18,
          pitch: 0.06,
        };
      }
      return { box, horizontal: 0.22, pitch: 0.1 };
    };
    const cameraRig = new CameraRig(sceneManager.camera, sceneManager.controls, frameOf);
    cameraRig.snapToFrame('normal');

    const lipsync = new LipSyncController(engine);
    const brain = new AvatarBrain(manager, layer, reactions, dances, emotions, cameraRig, lipsync);
    const detector = new MusicActivityDetector();
    const musicController = new MusicController(detector);
    musicController.attachBrain(brain);
    brain.setMusicEnergyBandProvider(() => (detector.isMusicActive() ? detector.getEnergyBand() : null));

    const skeletonHelper = new THREE.SkeletonHelper(avatar.root);
    skeletonHelper.visible = false;
    sceneManager.scene.add(skeletonHelper);

    // Retarget report → console
    const avgMapped = Math.round(clips.reduce((sum, c) => sum + c.mappedBones, 0) / clips.length);
    const missing = [...new Set(clips.flatMap((c) => c.missingOnSource))];
    console.info(`[avatar] retarget: ${avgMapped} bones mapped per clip; map entries missing on source: ${missing.join(', ') || 'none'}`);
    console.info(`[avatar] eye gaze: eye-adjunct bones ${behaviorBones.eyeL && behaviorBones.eyeR ? 'found' : 'NOT found'} — gaze uses head rotation ${behaviorBones.eyeL ? '+ eye-mesh micro-rotation' : 'only'}`);

    let paused = false;
    let selectedId: string | null = IDLE_CLIP_ID;

    const ui = new UIController({
      selectClip: (id) => {
        selectedId = id;
      },
      playSelected: () => {
        if (selectedId) manager.playAnimation(selectedId);
      },
      stopSelected: () => {
        manager.stopAnimation();
        ui.setNowPlaying('— stopped —');
      },
      resetSelected: () => {
        manager.resetAnimation();
        ui.setNowPlaying('— rest pose —');
      },
      setLoopMode: (mode: LoopMode, id) => {
        const target = id ?? manager.currentId;
        if (target) manager.setLoopMode(mode, target);
      },
      getLoopOverride: (id) => manager.getLoopOverride(id),
      backToIdle: () => brain.setState('IDLE'),
      setSpeed: (v) => manager.setSpeed(v),
      setPaused: (p) => {
        paused = p;
      },
      stateCommand: (state: UIStateCommand) => {
        if (state === 'IDLE' || state === 'GREETING' || state === 'DANCE') {
          brain.setState(state);
        } else {
          brain.react(state); // HAPPY/SAD/ANGRY/SURPRISED/THINKING → reaction + emotion
        }
      },
      setEmotion: (name: EmotionName) => brain.setEmotion(name),
      speakTest: (speed?: number) => brain.startSpeaking({ synthetic: true, syntheticSpeed: speed ?? 1, syntheticDurationS: 7 }),
      stopSpeaking: () => brain.stopSpeaking(),
      speakAudioFallback: () => brain.startSpeaking({ audioBuffer: lipsync.createBabbleBuffer(), outputGain: 0.22 }),
      setMusicOverride: (active: boolean) => musicController.setMusicState(active),
      startMusicAnalysisTest: () => musicController.startAnalysisTest(),
      stopMusicAnalysisTest: () => musicController.stopAnalysisTest(),
      setIdleBehavior: (on) => {
        layer.toggles.idle = on;
      },
      setAutoBlink: (on) => {
        layer.toggles.blink = on;
      },
      setEyeMovement: (on) => {
        layer.toggles.eyes = on;
      },
      setHeadMovement: (on) => {
        layer.toggles.head = on;
      },
      setSkeletonVisible: (on) => {
        skeletonHelper.visible = on;
      },
      setWireframe: (on) => setWireframe(avatar.root, on),
      setGridVisible: (on) => sceneManager.setGridVisible(on),
      setAutoOrbit: (on) => sceneManager.setAutoRotate(on),
      setCameraMode: (mode: CameraMode) => cameraRig.setMode(mode),
    });

    ui.setActions(clips);
    ui.setEmotions();
    manager.onCurrentChanged((id) => {
      ui.setActiveClip(id);
      if (id) {
        const clip = clips.find((c) => c.id === id);
        ui.setNowPlaying(clip ? clip.label : id);
      }
    });
    ui.setActiveClip(manager.currentId);
    ui.setNowPlaying(manager.nowPlaying ? manager.nowPlaying.label : '—');

    const morphCount = avatar.morphMeshes.reduce((sum, m) => sum + Object.keys(m.morphTargetDictionary ?? {}).length, 0);
    const categoryCounts = new Map<string, number>();
    for (const c of clips) categoryCounts.set(c.category, (categoryCounts.get(c.category) ?? 0) + 1);
    const categorySummary = [...categoryCounts.entries()].map(([cat, n]) => `${cat} ${n}`).join(' · ');

    const info: InfoRow[] = [
      { key: 'Bones', value: String(avatar.bones.length) },
      { key: 'Morphs', value: String(morphCount) },
      { key: 'Clips', value: String(clips.length) },
      { key: 'Categories', value: categorySummary || '—' },
      { key: 'Retarget', value: `${avgMapped} bones` },
      { key: 'Height', value: `${avatar.height.toFixed(2)} m` },
      { key: 'FPS', value: '—' },
    ];
    ui.setInfo(info);

    // Frame order matters: the mixer writes the base pose first, then the
    // emotion/behavior layers add their contribution, then the camera eases.
    let frames = 0;
    let acc = 0;
    let elapsed = 0;
    sceneManager.onFrame((dt) => {
      if (!paused) {
        elapsed += dt;
        manager.update(dt);
      }
      frames += 1;
      acc += dt;
      if (acc >= 0.5) {
        ui.updateInfoValue('FPS', String(Math.round(frames / acc)));
        frames = 0;
        acc = 0;
      }
    });
    sceneManager.onFrame((dt) => {
      if (paused) return;
      detector.update(dt);
      emotions.update(dt);
      brain.update(dt);
      cameraRig.update(dt);
    });

    // Live speaking/music debug readout — throttled, only touches the DOM on change.
    window.setInterval(() => {
      const d = lipsync.getDebug();
      ui.setSpeakingState(d.speaking);
      ui.setSpeakDebug(d);
      ui.setMusicDebug(musicController.getDebug());
    }, 180);

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        paused = !paused;
        ui.setPaused(paused);
      } else if (e.key.toLowerCase() === 'h') {
        ui.togglePanel();
      } else if (e.key.toLowerCase() === 'g') {
        brain.setState('GREETING');
      } else if (e.key.toLowerCase() === 'd') {
        brain.trigger('dance');
      } else if (e.key.toLowerCase() === 's') {
        if (lipsync.speaking) brain.stopSpeaking();
        else brain.startSpeaking({ synthetic: true, syntheticDurationS: 7 });
      } else if (e.key.toLowerCase() === 'i') {
        brain.setState('IDLE');
      } else if (/^[1-9]$/.test(e.key)) {
        const clip = clips[Number(e.key) - 1];
        if (clip) {
          selectedId = clip.id;
          manager.playAnimation(clip.id);
        }
      }
    });

    // Clean public API for the future ANUX integration (not wired to anything yet)
    // and the debug/test handle for automated inspection.
    const avatarApi = {
      setState: (s: 'IDLE' | 'GREETING' | 'DANCE') => brain.setState(s),
      setEmotion: (e: EmotionName) => brain.setEmotion(e),
      react: (r: Parameters<AvatarBrain['react']>[0]) => brain.react(r),
      trigger: (t: 'dance' | 'speak', options?: Parameters<AvatarBrain['startSpeaking']>[0]) => brain.trigger(t, options),
      startSpeaking: (o: Parameters<AvatarBrain['startSpeaking']>[0]) => brain.startSpeaking(o),
      stopSpeaking: () => brain.stopSpeaking(),
      /** ANUX seam: music signal from the host's own music-detection system. */
      setMusicState: (active: boolean) => musicController.setMusicState(active),
    };
    (window as unknown as Record<string, unknown>).avatar = avatarApi;
    (window as unknown as Record<string, unknown>).__avatarTest = {
      manager,
      brain,
      emotions,
      layer,
      dances,
      cameraRig,
      lipsync,
      musicController,
      detector,
      avatar,
      sceneManager,
    };

    loading.hide();
  } catch (err) {
    console.error(err);
    loading.setProgress(1, 'Failed to load');
    loading.showError(err instanceof Error ? err.message : String(err));
  }
}

function setWireframe(root: THREE.Object3D, on: boolean): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) (mat as THREE.MeshStandardMaterial).wireframe = on;
  });
}
