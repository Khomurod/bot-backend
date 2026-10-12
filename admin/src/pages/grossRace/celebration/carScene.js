/**
 * The celebration's car: a real 3D model, lit like a studio, the camera
 * circling it for the twelve seconds of the celebration.
 *
 * three.js and the model are loaded only when a celebration is near
 * (preloadCar(), a few minutes before 4 PM), never with the board itself, and
 * everything is released when the celebration ends: a screen that hangs on a
 * wall all day must not keep a WebGL context or 3 MB of model it no longer
 * shows.
 *
 * The model is "Car Concept" (CC BY 4.0), with its sponsor marks removed and
 * the plate reading WENZE — see CREDITS.md beside it.
 */
import carUrl from "./wenze-car.glb?url";

let modules = null;
function loadModules() {
  modules = modules || Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
    import("three/addons/environments/RoomEnvironment.js"),
  ]).catch((err) => { modules = null; throw err; });
  return modules;
}

async function fetchModel() {
  const res = await fetch(carUrl);
  if (!res.ok) throw new Error(`car model HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Warm the code and the model (the browser keeps them) so 4 PM starts on time. */
export async function preloadCar() {
  await Promise.all([loadModules(), fetchModel()]);
}

/** Whether this screen can draw 3D at all; without it the celebration is words only. */
export function supportsWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A round gradient texture, from `inner` in the middle to transparent at the edge. */
function radialTexture(THREE, inner, middle) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.5, middle);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/**
 * The lit circle of floor the car stands on. Without it the floor is not
 * seen at all and the car reads as floating against the background.
 */
function floorSpot(THREE) {
  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(6.5, 64),
    new THREE.MeshBasicMaterial({
      map: radialTexture(THREE, "rgba(150,138,132,0.42)", "rgba(110,96,90,0.22)"), transparent: true, depthWrite: false,
    }),
  );
  spot.rotation.x = -Math.PI / 2;
  spot.position.y = 0.001;
  return spot;
}

/** A soft round shadow, `w` × `d` on the floor at (x, z): darkest in the middle. */
function blob(THREE, texture, x, z, w, d, lift) {
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(x, lift, z);
  return shadow;
}

/**
 * Contact shadows, so the car stands on the floor instead of floating: a pool
 * no wider than the body (a wider one reads as the car hovering over its own
 * shadow), and a tight dark one under each wheel — the model's "Wheel…Rim"
 * nodes say where they are.
 */
function contactShadows(THREE, car, size) {
  const texture = radialTexture(THREE, "rgba(0,0,0,0.85)", "rgba(0,0,0,0.5)");
  const group = new THREE.Group();
  group.add(blob(THREE, texture, 0, 0, size.x * 0.98, size.z * 0.96, 0.003));
  const rim = new THREE.Box3();
  car.traverse((object) => {
    if (!/^Wheel\w*Rim$/.test(object.name)) return;
    rim.setFromObject(object, true);
    const centre = rim.getCenter(new THREE.Vector3());
    group.add(blob(THREE, texture, centre.x, centre.z, (rim.max.x - rim.min.x) * 0.8, (rim.max.z - rim.min.z) * 0.5, 0.005));
  });
  return group;
}

/**
 * Builds the scene on `canvas` and starts the camera move, `durationMs` long.
 * Resolves with { dispose } once the car is on screen; rejects if anything
 * fails, so the caller can fall back to words only.
 */
export async function mountCarScene(canvas, { durationMs }) {
  const [[THREE, { GLTFLoader }, { MeshoptDecoder }, { RoomEnvironment }], buffer] = await Promise.all([
    loadModules(), fetchModel(),
  ]);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;

  // A studio: a key light that casts the shadow, a cool fill, and a red rim
  // from behind that picks out the body lines in the board's colour.
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(1, 12, 1.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 30 });
  key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.6);
  fill.position.set(-6, 3, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xff5a3c, 1.6);
  rim.position.set(-3, 2.5, -7);
  scene.add(rim);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.ShadowMaterial({ opacity: 0.55 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floorSpot(THREE), floor);

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
  const car = gltf.scene;
  car.traverse((object) => {
    if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; }
  });
  // Centre it, stand it on the floor, and make it about 4.6 units long. The
  // boxes are PRECISE (from the vertices): the wheels are turned, and a turned
  // part's quick box reaches below the tyre, which left the car hovering.
  const box = new THREE.Box3().setFromObject(car, true);
  const size = box.getSize(new THREE.Vector3());
  const scale = 4.6 / Math.max(size.x, size.z);
  car.scale.setScalar(scale);
  car.updateMatrixWorld(true);
  box.setFromObject(car, true);
  const centre = box.getCenter(new THREE.Vector3());
  car.position.set(-centre.x, -box.min.y, -centre.z);
  car.updateMatrixWorld(true); // the wheels are measured below: they must be where the car now is
  scene.add(car);
  scene.add(contactShadows(THREE, car, box.getSize(new THREE.Vector3())));

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const target = new THREE.Vector3(0, 0.55, 0);
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  // Twelve seconds: from a low three-quarter front view, round the nose and
  // in close along the flank, slowing as it settles.
  const started = performance.now();
  let frame = 0;
  const draw = () => {
    const t = ease(Math.min(1, (performance.now() - started) / durationMs));
    const angle = -0.95 + 1.9 * t;
    const radius = 10.5 - 3.6 * t;
    camera.position.set(Math.sin(angle) * radius, 1.5 + 0.6 * (1 - t), Math.cos(angle) * radius);
    camera.lookAt(target);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  };
  draw();

  return {
    dispose() {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials.filter(Boolean)) {
          for (const value of Object.values(material)) if (value && value.isTexture) value.dispose();
          material.dispose();
        }
      });
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
