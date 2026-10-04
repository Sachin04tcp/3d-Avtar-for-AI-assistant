import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Owns the renderer, scene, camera, lights, ground and the render loop. */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly grid: THREE.GridHelper;
  private readonly clock = new THREE.Clock();
  private readonly frameCallbacks = new Set<(dt: number) => void>();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1218);
    this.scene.fog = new THREE.Fog(0x0e1218, 9, 20);

    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 80);
    this.camera.position.set(0.45, 1.2, 2.9);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    pmrem.dispose();

    // --- lighting ---
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2118, 0.5);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff2e0, 2.4);
    key.position.set(2.2, 3.6, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -2.5;
    key.shadow.camera.right = 2.5;
    key.shadow.camera.top = 3.5;
    key.shadow.camera.bottom = -1;
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8fb7ff, 1.1);
    rim.position.set(-2.6, 2.2, -2.4);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1.5, 1.2, 2.2);
    this.scene.add(fill);

    // --- ground ---
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 96),
      new THREE.MeshStandardMaterial({ color: 0x161b22, roughness: 0.96, metalness: 0 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.receiveShadow = true;
    this.scene.add(disc);

    this.grid = new THREE.GridHelper(12, 48, 0x2c3644, 0x1c242e);
    const gridMat = this.grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.45;
    this.grid.position.y = 0.002;
    this.scene.add(this.grid);

    // --- controls ---
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.85, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI * 0.55;
    this.controls.autoRotateSpeed = 1.4;
    this.controls.update();

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.renderer.setAnimationLoop(() => {
      const dt = this.clock.getDelta();
      for (const cb of this.frameCallbacks) cb(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Register a per-frame callback (dt in seconds). Returns an unregister function. */
  onFrame(cb: (dt: number) => void): () => void {
    this.frameCallbacks.add(cb);
    return () => this.frameCallbacks.delete(cb);
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
  }
}
