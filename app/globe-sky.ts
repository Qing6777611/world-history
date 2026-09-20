import type { PerspectiveCamera, Scene } from "three";

// One surrounding sky, viewed through the globe's own camera. Brightness is
// applied to the stars only, leaving the ocean, countries and labels unchanged.
export function createGlobeSky(THREE: typeof import("three"), scene: Scene, camera: PerspectiveCamera) {
  let disposed = false;
  const texture = new THREE.TextureLoader().load("/textures/night-sky.png", loaded => {
    if (disposed) loaded.dispose();
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  const skyMaterial = new THREE.MeshBasicMaterial({
    map: texture, side: THREE.BackSide, depthWrite: false, toneMapped: false,
  });
  skyMaterial.color.setRGB(2.8, 2.8, 2.8);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 48, 32), skyMaterial);
  sky.name = "atlas-star-field";
  sky.renderOrder = -1;
  scene.add(sky);

  // Reuse one slim, feathered streak. The globe naturally occludes it, and
  // world-space placement keeps it attached to the sky while the user drags.
  const streakGeometry = new THREE.PlaneGeometry(1, 1);
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
  const streak = new THREE.Mesh(streakGeometry, streakMaterial);
  streak.name = "atlas-meteor";
  streak.visible = false;
  streak.raycast = () => {};
  sky.raycast = () => {};
  scene.add(streak);

  // Curved ribbons sit on the same celestial sphere as the stars. They follow
  // the camera's orbital direction and are occluded by the globe itself.
  const arcs=180, segments=18;
  const longitude:number[]=[],latitude:number[]=[],progress:number[]=[],side:number[]=[],brightness:number[]=[];
  const positions:number[]=[],indices:number[]=[];
  let seed=217;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let arc=0;arc<arcs;arc++) {
    const lng=random()*Math.PI*2,lat=Math.asin(random()*1.94-.97),light=.45+random()*.55;
    const base=positions.length/3;
    for(let step=0;step<=segments;step++)for(const edge of [-1,1]) {
      positions.push(0,0,0);longitude.push(lng);latitude.push(lat);
      progress.push(step/segments);side.push(edge);brightness.push(light);
    }
    for(let step=0;step<segments;step++) {
      const a=base+step*2;indices.push(a,a+1,a+2,a+2,a+1,a+3);
    }
  }
  const trailGeometry=new THREE.BufferGeometry();
  trailGeometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  for(const [name,values] of Object.entries({aLongitude:longitude,aLatitude:latitude,aProgress:progress,aSide:side,aBrightness:brightness})) {
    trailGeometry.setAttribute(name,new THREE.Float32BufferAttribute(values,1));
  }
  trailGeometry.setIndex(indices);
  const trailMaterial=new THREE.ShaderMaterial({
    uniforms:{strength:{value:0},direction:{value:1}},
    vertexShader:`
      uniform float strength;
      uniform float direction;
      attribute float aLongitude;
      attribute float aLatitude;
      attribute float aProgress;
      attribute float aSide;
      attribute float aBrightness;
      varying float vProgress;
      varying float vSide;
      varying float vBrightness;
      void main() {
        vProgress=aProgress;vSide=aSide;vBrightness=aBrightness;
        float angle=aLongitude+direction*aProgress*(.04+strength*.72);
        float latitude=aLatitude+aSide*(.0006+strength*.0015)*(1.0-aProgress*.7);
        vec3 point=8000.0*vec3(cos(latitude)*sin(angle),sin(latitude),cos(latitude)*cos(angle));
        gl_Position=projectionMatrix*viewMatrix*vec4(point,1.0);
      }
    `,
    fragmentShader:`
      uniform float strength;
      varying float vProgress;
      varying float vSide;
      varying float vBrightness;
      void main() {
        float core=exp(-vSide*vSide*14.0)+.22*exp(-vSide*vSide*2.5);
        float tail=pow(1.0-vProgress,1.5);
        vec3 color=mix(vec3(.54,.75,1.0),vec3(.96,.93,.82),vBrightness);
        gl_FragColor=vec4(color,core*tail*vBrightness*strength*.85);
      }
    `,
    transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,
    blending:THREE.AdditiveBlending,toneMapped:false,
  });
  const trails=new THREE.Mesh(trailGeometry,trailMaterial);
  trails.name="atlas-time-trails";trails.visible=false;trails.frustumCulled=false;
  trails.raycast=()=>{};scene.add(trails);
  let warpStrength=0,lastWarpAt=performance.now();

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
    get warping() { return warpStrength>.08; },
    update(now: number,travelSpeed=0) {
      const dt=Math.min(.05,Math.max(0,(now-lastWarpAt)/1000));lastWarpAt=now;
      const target=motion.matches || document.hidden ? 0 : Math.max(0,Math.min(1,(Math.abs(travelSpeed)-35)/500));
      warpStrength+=(target-warpStrength)*(1-Math.exp(-dt*9));
      if(motion.matches || document.hidden)warpStrength=0;
      trailMaterial.uniforms.strength.value=warpStrength;
      if(Math.abs(travelSpeed)>2)trailMaterial.uniforms.direction.value=Math.sign(travelSpeed);
      trails.visible=warpStrength>.005;
      // Let the luminous trails carry the speed without flashing the background.
      const starBrightness=2.8-warpStrength*1.1;
      skyMaterial.color.setRGB(starBrightness,starBrightness,starBrightness);
      if (motion.matches || document.hidden) {
        streak.visible = false;
        schedule(now);
        return;
      }
      if(warpStrength>.08){streak.visible=false;schedule(now);return;}
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
    dispose() {
      disposed = true;
      scene.remove(sky, streak, trails);
      sky.geometry.dispose(); skyMaterial.dispose(); texture.dispose();
      streakGeometry.dispose(); streakMaterial.dispose();
      trailGeometry.dispose();trailMaterial.dispose();
    },
  };
}
