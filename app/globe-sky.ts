import type { PerspectiveCamera, Scene } from "three";
import { createGlobeLifetime } from "./globe-lifecycle";

// One surrounding sky, viewed through the globe's own camera. Brightness is
// applied to the stars only, leaving the ocean, countries and labels unchanged.
export function createGlobeSky(THREE: typeof import("three"), scene: Scene, camera: PerspectiveCamera) {
  const lifetime = createGlobeLifetime();
  try {
    const skyMaterial = new THREE.MeshBasicMaterial({
      side: THREE.BackSide, depthWrite: false, toneMapped: false,
    });
    lifetime.add(() => skyMaterial.dispose());
    skyMaterial.color.setRGB(2.8, 2.8, 2.8);
    const skyGeometry = new THREE.SphereGeometry(12000, 48, 32);
    lifetime.add(() => skyGeometry.dispose());
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.visible = false;
    sky.name = "atlas-star-field";
    sky.renderOrder = -1;
    scene.add(sky);
    lifetime.add(() => scene.remove(sky));

    // Keep the original artwork, but let the map paint before requesting its
    // decorative texture. Fetch is abortable if startup fails or the view closes.
    const loadTexture = async () => {
      try {
        const response = await fetch("/textures/night-sky.png", { signal: lifetime.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        if (lifetime.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        lifetime.add(() => URL.revokeObjectURL(url));
        const texture = new THREE.TextureLoader().load(url, loaded => {
          URL.revokeObjectURL(url);
          if (lifetime.signal.aborted) return;
          loaded.colorSpace = THREE.SRGBColorSpace;
          skyMaterial.map = loaded;
          skyMaterial.needsUpdate = true;
          sky.visible = true;
        }, undefined, () => { URL.revokeObjectURL(url); });
        lifetime.add(() => texture.dispose());
      } catch { /* The decorative sky may fail without affecting the map. */ }
    };
    const textureDelay = window.setTimeout(() => {
      if (lifetime.signal.aborted) return;
      if ("requestIdleCallback" in window) {
        const idle = window.requestIdleCallback(() => { void loadTexture(); }, { timeout: 2000 });
        lifetime.add(() => window.cancelIdleCallback(idle));
      } else {
        void loadTexture();
      }
    }, 1200);
    lifetime.add(() => window.clearTimeout(textureDelay));

    // Reuse one slim, feathered streak. The globe naturally occludes it, and
    // world-space placement keeps it attached to the sky while the user drags.
    const streakGeometry = new THREE.PlaneGeometry(1, 1);
    lifetime.add(() => streakGeometry.dispose());
    streakGeometry.translate(-.5, 0, 0);
    const streakMaterial = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          float core = exp(-pow((vUv.y - .5) * 22.0, 2.0));
          float halo = exp(-pow((vUv.y - .5) * 7.0, 2.0)) * .16;
          float tail = pow(vUv.x, 1.8) * (1.0 - smoothstep(.96, 1.0, vUv.x));
          float alpha = (core + halo) * tail * opacity;
          gl_FragColor = vec4(.76, .87, 1.0, alpha);
        }
      `,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    lifetime.add(() => streakMaterial.dispose());
    const streak = new THREE.Mesh(streakGeometry, streakMaterial);
    streak.name = "atlas-meteor";
    streak.visible = false;
    streak.raycast = () => {};
    sky.raycast = () => {};
    scene.add(streak);
    lifetime.add(() => scene.remove(streak));

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = new THREE.Vector3(), travel = new THREE.Vector3();
    const worldPoint = new THREE.Vector3(), direction = new THREE.Vector3();
    let nextAt = performance.now() + 3200 + Math.random() * 2000;
    let startedAt = 0, duration = 1400;
    const schedule = (now: number) => { nextAt = now + 9000 + Math.random() * 11000; };

    function launch(now: number) {
      camera.updateMatrixWorld();
      const side = Math.random() < .5 ? -1 : 1;
      const x = side * (.76 + Math.random() * .12);
      const y = .64 + Math.random() * .18;
      const distance = 6000;
      // Start in the upper corners so most of the short trail is visible
      // beside the globe, even in the narrow mobile composition.
      worldPoint.set(x, y, .5).unproject(camera);
      start.copy(worldPoint).sub(camera.position).normalize().multiplyScalar(distance).add(camera.position);
      const angle = side < 0 ? -.72 : -Math.PI + .72;
      direction.set(Math.cos(angle), Math.sin(angle), 0).applyQuaternion(camera.quaternion);
      const viewHeight = 2 * distance * Math.tan(camera.fov * Math.PI / 360);
      travel.copy(direction).multiplyScalar(viewHeight * (.23 + Math.random() * .1));
      streak.position.copy(start);
      streak.quaternion.copy(camera.quaternion);
      streak.rotateZ(angle);
      streak.scale.set(viewHeight * (.1 + Math.random() * .035), viewHeight * .008, 1);
      startedAt = now;
      duration = 1250 + Math.random() * 500;
      streak.visible = true;
    }

    return {
      get active() { return streak.visible && streakMaterial.uniforms.opacity.value > .35; },
      update(now: number) {
        if (motion.matches || document.hidden) {
          streak.visible = false;
          schedule(now);
          return;
        }
        if (!streak.visible && now >= nextAt) launch(now);
        if (!streak.visible) return;
        const progress = (now - startedAt) / duration;
        if (progress >= 1) {
          streak.visible = false;
          schedule(now);
          return;
        }
        streak.position.copy(start).addScaledVector(travel, progress);
        const fadeIn = Math.min(1, progress / .14);
        const fadeOut = Math.min(1, (1 - progress) / .46);
        streakMaterial.uniforms.opacity.value = .88 * fadeIn * fadeOut;
      },
      dispose() { lifetime.dispose(); },
    };
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}
