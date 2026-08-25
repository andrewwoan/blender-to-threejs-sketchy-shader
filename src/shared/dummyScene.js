import * as THREE from "three/webgpu";
import { QUALITY } from "./quality.js";

/**
 * The stand-in for a real scene. Both panes build an identical copy of this, so
 * anything you see differ between them is the method and nothing else.
 *
 * The cast is chosen to exercise the two techniques where they disagree most:
 *
 *  - a CUBE. Hard creases and a flat silhouette. This is where an inverted hull
 *    needs its normals smoothed, and where a screen-space pass has to find the
 *    crease from a normal discontinuity.
 *  - a TORUS KNOT. Continuous curvature, self-occluding. Its inner contours are
 *    the case an inverted hull structurally cannot draw — a hull only ever
 *    produces a silhouette — while the edge pass inks them for free.
 *  - a SPHERE. A clean tone ramp, so you can read the hatching's response to
 *    lighting on its own, away from any edges.
 *  - a GROUND PLANE. Gives the silhouettes something to sit against, and shows
 *    how each method handles a surface that meets another at a shallow angle.
 *
 * Geometry is rebuilt per pane rather than shared: each pane owns its own
 * WebGPU device, and method A mutates geometry (it smooths normals on a clone),
 * so shared buffers would quietly couple the two.
 */
export function createDummyScene({ makeMaterial }) {
  const scene = new THREE.Scene();

  // A near-white void, so the paper multiply in the grade has something to
  // multiply. Left at the default black, everything above the horizon comes out
  // as a black slab and the drawing stops reading as ink on a sheet.
  scene.background = new THREE.Color(0xfaf7f0);

  const spinners = [];

  const add = (geometry, position, { spin = null, material = null } = {}) => {
    const mesh = new THREE.Mesh(geometry, material ?? makeMaterial());
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (spin) spinners.push({ mesh, spin });
    return mesh;
  };

  const cube = add(new THREE.BoxGeometry(1.25, 1.25, 1.25), [-1.15, 0.05, 0], {
    spin: [0.35, 0.5, 0.12],
    material: makeMaterial({ color: 0xe8ddc8 }),
  });

  const knot = add(
    new THREE.TorusKnotGeometry(0.52, 0.19, 160, 24),
    [1.2, 0.15, -0.1],
    { spin: [0.28, -0.42, 0.2], material: makeMaterial({ color: 0xd9c7b4 }) },
  );

  const sphere = add(new THREE.SphereGeometry(0.55, 48, 32), [0.05, -0.62, 1.25], {
    material: makeMaterial({ color: 0xcfd8e0 }),
  });

  // The ground needs its UVs scaled, and WHY is worth understanding, because it
  // is method A's central trade-off showing up in the very first scene you build.
  //
  // Both methods sample the hatch sheet through the mesh's own UVs. A 1.25-unit
  // cube unwrapped to 0..1 gets its strokes at one density; a 14-unit plane
  // unwrapped to the same 0..1 gets them stretched eleven times wider, and the
  // hatching turns into long smears. There is no shader setting that fixes it -
  // the density is a property of the UNWRAP, so it has to be fixed in the
  // geometry (or in Blender, before export).
  //
  // Multiply the UVs by roughly the plane's size ratio and the strokes come out
  // the same size as everything else's.
  // Big enough that its far edge never enters frame at any pane shape.
  const groundGeometry = new THREE.PlaneGeometry(48, 48);
  const groundUV = groundGeometry.attributes.uv;
  for (let i = 0; i < groundUV.count; i++) {
    groundUV.setXY(i, groundUV.getX(i) * 38, groundUV.getY(i) * 38);
  }

  // The ground is the surface a cast shadow actually gets DRAWN on, so it is the
  // one that opts into hatched shadows. The objects keep stock shadow behaviour:
  // their own shading is already carried by the hatch.
  const ground = new THREE.Mesh(
    groundGeometry,
    makeMaterial({ color: 0xf2ede4, drawnShadow: true }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.15;
  ground.receiveShadow = true;
  ground.castShadow = false;
  scene.add(ground);

  return {
    scene,
    ground,
    meshes: [cube, knot, sphere, ground],
    update: (delta) => {
      for (const { mesh, spin } of spinners) {
        mesh.rotation.x += spin[0] * delta;
        mesh.rotation.y += spin[1] * delta;
        mesh.rotation.z += spin[2] * delta;
      }
    },
  };
}

/**
 * A single directional key light plus a soft ambient fill.
 *
 * Both hatch materials shade off `lightDirectionWorld` — a uniform holding the
 * world-space direction from the surface TOWARD the light — rather than off the
 * scene's real lighting. That is not a shortcut: the hatch density has to be a
 * deliberate, art-directed ramp, and reading it from whatever lights happen to
 * be in the scene makes it impossible to control. The real light is still there
 * for shadows and for the underlying MeshStandard response.
 *
 * `syncLightDirection` is what keeps the two in agreement.
 */
export function createLighting(scene) {
  const ambient = new THREE.AmbientLight(0xffffff, 1.6);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  // Same DIRECTION as (2.5, 4, 2) - which is all the hatching and the ortho
  // shadow camera actually read - but pulled in until the light sits INSIDE the
  // default framing. A gizmo handle you cannot see is a handle nobody finds, and
  // distance is free for a directional light.
  key.position.set(1.12, 1.64, 0.9);
  key.castShadow = true;
  // A wide, heavily blurred penumbra. This is not for realism - it is the field
  // the materials read to work out how deep into a shadow they are, which is
  // what drives both the contact darkening and the fade at the edge.
  //
  // `radius` is in SHADOW-MAP TEXELS, so what it is worth in world units is
  // `radius * frustumWidth / mapSize`. That is the trap: at 1024 over this
  // 12-unit frustum a texel is 0.012 units, so even radius 8 is a 0.1-unit
  // blur - a hairline on a shadow two units across. The fade then exists only
  // as a thin rim, and no amount of reshaping it in the material helps, because
  // the field is already 1 across the whole interior.
  //
  // Halving the map doubles the world size of a texel, which buys penumbra far
  // more cheaply than pushing the radius alone (the blur costs
  // 2 * blurSamples taps per shadow texel). Blockiness in the map does not
  // matter here - it is about to be blurred hard and then drawn as strokes.
  key.shadow.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
  // Radius is in TEXELS, so halving the map doubles what one is worth - see
  // quality.js. Both settings together keep the same world-space penumbra.
  key.shadow.radius = QUALITY.shadowRadius;
  key.shadow.blurSamples = QUALITY.shadowBlurSamples;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  scene.add(key);
  scene.add(key.target);

  return { ambient, key };
}

/** Push the real light's direction into a hatch material's uniform set. */
export function syncLightDirection(key, lightDirectionWorld) {
  lightDirectionWorld.value
    .subVectors(key.position, key.target.position)
    .normalize();
}
