import type { ClipBuildResult } from '../avatar/ClipLibrary';
import type { LoopMode } from '../avatar/AnimationManager';
import type { CameraMode } from '../core/CameraRig';
import { EMOTION_NAMES } from '../config';
import type { EmotionName } from '../config';

export type UIStateCommand = 'IDLE' | 'GREETING' | 'HAPPY' | 'SAD' | 'ANGRY' | 'SURPRISED' | 'THINKING' | 'DANCE';

export interface UIHandlers {
  selectClip(id: string): void;
  playSelected(): void;
  stopSelected(): void;
  resetSelected(): void;
  setLoopMode(mode: LoopMode, id: string | null): void;
  getLoopOverride(id: string): LoopMode;
  backToIdle(): void;
  setSpeed(mult: number): void;
  setPaused(paused: boolean): void;
  stateCommand(state: UIStateCommand): void;
  setEmotion(name: EmotionName): void;
  speakTest(speed?: number): void;
  stopSpeaking(): void;
  speakAudioFallback(): void;
  setMusicOverride(active: boolean): void;
  startMusicAnalysisTest(): void;
  stopMusicAnalysisTest(): void;
  setIdleBehavior(on: boolean): void;
  setAutoBlink(on: boolean): void;
  setEyeMovement(on: boolean): void;
  setHeadMovement(on: boolean): void;
  setSkeletonVisible(on: boolean): void;
  setWireframe(on: boolean): void;
  setGridVisible(on: boolean): void;
  setAutoOrbit(on: boolean): void;
  setCameraMode(mode: CameraMode): void;
}

export interface InfoRow {
  key: string;
  value: string;
}

/** Developer test panel (Phase 2.15): state, emotions, clips, camera, behavior toggles. */
export class UIController {
  private readonly handlers: UIHandlers;
  private readonly animList = document.getElementById('anim-list')!;
  private readonly emotionList = document.getElementById('emotion-list')!;
  private readonly infoList = document.getElementById('info')!;
  private readonly panel = document.getElementById('panel')!;
  private readonly panelShow = document.getElementById('panel-show')!;
  private readonly speedVal = document.getElementById('speed-val')!;
  private readonly nowPlaying = document.getElementById('now-playing')!;
  private readonly loopSelect = document.getElementById('loop-mode') as HTMLSelectElement;

  private readonly animButtons = new Map<string, HTMLButtonElement>();
  private readonly cameraButtons = new Map<string, HTMLButtonElement>();
  private selectedId: string | null = null;

  constructor(handlers: UIHandlers) {
    this.handlers = handlers;
    this.wireState();
    this.wirePlayback();
    this.wireCamera();
    this.wireBehavior();
    this.wireView();
    this.wirePanelToggle();
  }

  setActions(clips: ClipBuildResult[]): void {
    this.animList.innerHTML = '';
    this.animButtons.clear();
    clips.forEach((clip, index) => {
      const btn = document.createElement('button');
      btn.className = 'anim-btn';
      btn.dataset.id = clip.id;
      const label = document.createElement('span');
      label.textContent = clip.label;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const kind = clip.kind === 'once' ? '◇ once' : '∞ loop';
      meta.textContent = `${clip.category} · ${clip.clip.duration.toFixed(1)}s · ${kind}${index < 9 ? ` · key ${index + 1}` : ''}`;
      btn.append(label, meta);
      btn.addEventListener('click', () => {
        this.selectClip(clip.id);
        this.handlers.playSelected();
      });
      this.animButtons.set(clip.id, btn);
      this.animList.appendChild(btn);
    });
  }

  setEmotions(): void {
    this.emotionList.innerHTML = '';
    for (const name of EMOTION_NAMES) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.emotion = name;
      chip.textContent = name.charAt(0) + name.slice(1).toLowerCase();
      chip.addEventListener('click', () => {
        this.setActiveEmotion(name);
        this.handlers.setEmotion(name);
      });
      this.emotionList.appendChild(chip);
    }
  }

  setActiveEmotion(name: EmotionName): void {
    for (const chip of Array.from(this.emotionList.children) as HTMLButtonElement[]) {
      chip.classList.toggle('active', chip.dataset.emotion === name);
    }
  }

  setCameraMode(mode: CameraMode): void {
    for (const [m, btn] of this.cameraButtons) btn.classList.toggle('active', m === mode);
  }

  private selectClip(id: string): void {
    this.selectedId = id;
    for (const [clipId, btn] of this.animButtons) {
      btn.classList.toggle('selected', clipId === id);
    }
    this.handlers.selectClip(id);
    const override = this.handlers.getLoopOverride(id);
    if (override) this.loopSelect.value = override;
  }

  setActiveClip(id: string | null): void {
    for (const [clipId, btn] of this.animButtons) {
      btn.classList.toggle('active', clipId === id);
      if (id === null && clipId === this.selectedId) btn.classList.add('selected');
    }
  }

  setNowPlaying(label: string): void {
    this.nowPlaying.textContent = label;
  }

  setSpeedLabel(mult: number): void {
    this.speedVal.textContent = `${mult.toFixed(2)}×`;
  }

  setInfo(rows: InfoRow[]): void {
    this.infoList.innerHTML = '';
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.textContent = row.key;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      dd.id = `info-${slug(row.key)}`;
      this.infoList.append(dt, dd);
    }
  }

  updateInfoValue(key: string, value: string): void {
    const dd = document.getElementById(`info-${slug(key)}`);
    if (dd) dd.textContent = value;
  }

  setPaused(paused: boolean): void {
    (document.getElementById('btn-pause') as HTMLInputElement).checked = paused;
  }

  togglePanel(): void {
    const hidden = this.panel.classList.toggle('hidden');
    this.panelShow.classList.toggle('hidden', !hidden);
  }

  private wireState(): void {
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('#state-buttons .mini-btn'))) {
      btn.addEventListener('click', () => this.handlers.stateCommand(btn.dataset.state as UIStateCommand));
    }
    document.getElementById('btn-speak')!.addEventListener('click', () => this.handlers.speakTest());
    document.getElementById('btn-speak-stop')!.addEventListener('click', () => this.handlers.stopSpeaking());
    document.getElementById('btn-speak-fast')!.addEventListener('click', () => this.handlers.speakTest(1.6));
    document.getElementById('btn-speak-slow')!.addEventListener('click', () => this.handlers.speakTest(0.6));
    document.getElementById('btn-speak-audio')!.addEventListener('click', () => this.handlers.speakAudioFallback());
    document.getElementById('btn-music-on')!.addEventListener('click', () => this.handlers.setMusicOverride(true));
    document.getElementById('btn-music-off')!.addEventListener('click', () => this.handlers.setMusicOverride(false));
    document.getElementById('btn-music-analysis')!.addEventListener('click', () => this.handlers.startMusicAnalysisTest());
    document.getElementById('btn-music-stop-test')!.addEventListener('click', () => this.handlers.stopMusicAnalysisTest());
  }

  setMusicDebug(debug: { active: boolean; mode: string; band: string; level: number; testRunning: boolean }): void {
    const stateEl = document.getElementById('music-state')!;
    const text = debug.active ? 'ON' : 'OFF';
    if (stateEl.textContent !== text) {
      stateEl.textContent = text;
      stateEl.style.color = debug.active ? 'var(--accent)' : 'var(--danger-text)';
    }
    const srcEl = document.getElementById('music-src')!;
    const src = `${debug.mode}${debug.testRunning ? ' + test audio' : ''} · ${debug.band} · lv ${debug.level.toFixed(2)}`;
    if (srcEl.textContent !== src) srcEl.textContent = src;
  }

  setSpeakingState(on: boolean): void {
    const el = document.getElementById('speak-state')!;
    if (el.textContent === (on ? 'ON' : 'OFF')) return;
    el.textContent = on ? 'ON' : 'OFF';
    el.style.color = on ? 'var(--accent)' : 'var(--danger-text)';
  }

  setSpeakDebug(debug: { viseme: string; intensity: number; openness: number }): void {
    (document.getElementById('speak-viseme') as HTMLElement).textContent = debug.viseme;
    (document.getElementById('speak-intensity') as HTMLElement).textContent = debug.intensity.toFixed(2);
    (document.getElementById('speak-openness') as HTMLElement).textContent = debug.openness.toFixed(2);
  }

  private wirePlayback(): void {
    document.getElementById('btn-play')!.addEventListener('click', () => this.handlers.playSelected());
    document.getElementById('btn-stop')!.addEventListener('click', () => this.handlers.stopSelected());
    document.getElementById('btn-reset')!.addEventListener('click', () => this.handlers.resetSelected());
    document.getElementById('btn-idle')!.addEventListener('click', () => this.handlers.backToIdle());

    this.loopSelect.addEventListener('change', () => {
      this.handlers.setLoopMode(this.loopSelect.value as LoopMode, this.selectedId);
    });

    const pause = document.getElementById('btn-pause') as HTMLInputElement;
    pause.addEventListener('change', () => this.handlers.setPaused(pause.checked));
    const speed = document.getElementById('speed') as HTMLInputElement;
    speed.addEventListener('input', () => {
      const v = Number(speed.value);
      this.setSpeedLabel(v);
      this.handlers.setSpeed(v);
    });
  }

  private wireCamera(): void {
    for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('#camera-modes .mini-btn'))) {
      this.cameraButtons.set(btn.dataset.cam!, btn);
      btn.addEventListener('click', () => this.handlers.setCameraMode(btn.dataset.cam as CameraMode));
    }
    this.setCameraMode('auto');
  }

  private wireBehavior(): void {
    bindCheck('bhv-idle', (on) => this.handlers.setIdleBehavior(on));
    bindCheck('bhv-blink', (on) => this.handlers.setAutoBlink(on));
    bindCheck('bhv-eyes', (on) => this.handlers.setEyeMovement(on));
    bindCheck('bhv-head', (on) => this.handlers.setHeadMovement(on));
  }

  private wireView(): void {
    bindCheck('chk-skeleton', (on) => this.handlers.setSkeletonVisible(on));
    bindCheck('chk-wireframe', (on) => this.handlers.setWireframe(on));
    bindCheck('chk-grid', (on) => this.handlers.setGridVisible(on));
    bindCheck('chk-orbit', (on) => this.handlers.setAutoOrbit(on));
  }

  private wirePanelToggle(): void {
    document.getElementById('panel-collapse')!.addEventListener('click', () => this.togglePanel());
    this.panelShow.addEventListener('click', () => this.togglePanel());
  }
}

function bindCheck(id: string, cb: (on: boolean) => void): void {
  const input = document.getElementById(id) as HTMLInputElement;
  input.addEventListener('change', () => cb(input.checked));
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
