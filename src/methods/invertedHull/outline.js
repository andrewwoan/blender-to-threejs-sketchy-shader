import * as THREE from "three/webgpu";
import {
  positionLocal,
  normalLocal,
  time,
  hash,
  vec3,
  uniform,
  color,
} from "three/tsl";

/**
 * METHOD A - the outline as GEOMETRY: an inverted hull.
 *
 * For every mesh, add a child mesh with the same geometry, rendered BackSide and
 * pushed outward along its normals. The front faces of the real mesh cover the
 * hull everywhere except a thin rim around the silhouette, and that rim is the
 * line.
 *
 * What this buys you:
 *  - It costs one extra draw call per mesh and no post-processing at all. There
 *    is no depth buffer to read, no normal buffer to write, and it composites
 *    correctly with anything - including transparency - because it IS geometry.
 *  - The line is in world space, so it is rock steady under camera motion. No
 *    screen-space technique gets this for free.
 *  - You can vary it per object trivially (see `makeThicknessMaterial`).
 *
 * What it cannot do:
 *  - Interior contours. A hull only ever produces a silhouette, so a torus knot
 *    passing in front of itself gets no line at the crossing. Method B does.
 *  - Uniform on-screen width. The hull is inflated in object space, so a distant
 *    object's line thins out and a huge object's line fattens. Sometimes that
 *    reads as depth and is wanted; often it is just wrong.
 *  - Hard-edged models, without help. See `smoothNormals` below - this is the
 *    thing that bites everyone.
 *
 * The boil: rather than boiling a texture, this boils the VERTICES. Each one is
 * offset by a hash of its own position, and both the offset and the per-vertex
 * thickness are seeded on a floor()'d clock, so the whole outline redraws itself
 * a few times a second and holds in between. Because the hash is seeded on
 * object-local position, a given vertex gets the same wobble every time the
 * clock lands on the same tick - the line jitters, it does not crawl.
 */
export class Outline {
  constructor({ gui = null } = {}) {
    this.uThickness = uniform(0.02);
    this.uJitterAmount = uniform(0.008);
    this.uJitterSpeed = uniform(10.0);
    this.uColor = uniform(color(0x1a1410)); // dark brown ink, not pure black
    this.uThicknessVariation = uniform(0.4); // 0 = uniform, 1 = lots of variation

    this.outlineMeshes = [];
    this.material = this.buildMaterial(this.uThickness);

    if (gui) this.setupGUI(gui);
  }

  /**
   * An inverted-hull outline material. Every uniform is shared except
   * `uThickness`, which is passed in so one scene can hand different objects
   * their own line weight off the same jitter settings.
   */
  buildMaterial(uThickness) {
    const steppedTime = time.mul(this.uJitterSpeed).floor();

    // Per-vertex position wobble. Seeded on the vertex's own local position, so
    // the same vertex always draws the same wobble on the same tick.
    const jitterSeed = positionLocal.add(steppedTime);
    const jitter = vec3(
      hash(jitterSeed),
      hash(jitterSeed.add(1.234)),
      hash(jitterSeed.add(5.678)),
    )
      .sub(0.5)
      .mul(this.uJitterAmount);

    // Thickness variation - each vertex gets a slightly different line weight,
    // on a clock offset from the jitter's so the two do not step in unison.
    const thicknessNoise = hash(positionLocal.add(steppedTime.mul(0.7)));
    const variedThickness = uThickness.mul(
      thicknessNoise
        .mul(this.uThicknessVariation)
        .add(this.uThicknessVariation.oneMinus()),
    );

    // Inflate along the normal, then displace.
    const inflated = positionLocal.add(normalLocal.mul(variedThickness));

    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    material.positionNode = inflated.add(jitter);
    material.colorNode = this.uColor;
    return material;
  }

  /** An outline material with its own fixed thickness, independent of the GUI. */
  makeThicknessMaterial(value) {
    return this.buildMaterial(uniform(value));
  }

  /**
   * Give every mesh under `root` a hull. Meshes can opt out with
   * `userData.noOutline` - useful for anything whose silhouette is produced by
   * the shader rather than the geometry (a dissolve, a cutout plane, a glow),
   * where a hull would ink an outline the visible surface no longer has.
   */
  apply(root, material = this.material) {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData.isOutline) return;
      if (obj.userData.noOutline) return;

      const outlineGeometry = obj.geometry.clone();
      this.smoothNormals(outlineGeometry);

      const outlineMesh = new THREE.Mesh(outlineGeometry, material);
      outlineMesh.userData.isOutline = true;
      outlineMesh.castShadow = false;
      outlineMesh.receiveShadow = false;

      // Added as a CHILD, so it inherits the parent's transform for free and
      // follows any animation without a per-frame sync.
      obj.add(outlineMesh);
      this.outlineMeshes.push(outlineMesh);
    });
  }

  /**
   * Average the normals of every vertex that shares a position.
   *
   * This is the step people miss, and without it hard-edged models come apart.
   * A cube exported from any DCC has 24 vertices, not 8: each corner exists
   * three times, once per face, each with that face's normal. Inflate along
   * those and the three copies fly apart along three different axes, splitting
   * the hull open at every corner and edge.
   *
   * Averaging them first gives each corner one shared outward direction, so the
   * hull inflates as a single closed shell. Positions are rounded to a grid
   * before matching, because "the same position" in a float buffer rarely means
   * bit-identical.
   *
   * Done on a CLONE of the geometry - the visible mesh keeps its hard shading.
   */
  smoothNormals(geometry) {
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;

    const posMap = new Map();
    const precision = 1000; // 3 decimal places, i.e. millimetres at scene scale

    for (let i = 0; i < position.count; i++) {
      const key = [
        Math.round(position.getX(i) * precision),
        Math.round(position.getY(i) * precision),
        Math.round(position.getZ(i) * precision),
      ].join(",");

      if (!posMap.has(key)) posMap.set(key, []);
      posMap.get(key).push(i);
    }

    const tempNormal = new THREE.Vector3();
    for (const indices of posMap.values()) {
      tempNormal.set(0, 0, 0);
      for (const i of indices) {
        tempNormal.x += normal.getX(i);
        tempNormal.y += normal.getY(i);
        tempNormal.z += normal.getZ(i);
      }
      tempNormal.normalize();
      for (const i of indices) {
        normal.setXYZ(i, tempNormal.x, tempNormal.y, tempNormal.z);
      }
    }

    normal.needsUpdate = true;
  }

  setupGUI(gui) {
    const folder = gui.addFolder("A - Outline (inverted hull)");

    const params = {
      thickness: this.uThickness.value,
      jitterAmount: this.uJitterAmount.value,
      jitterSpeed: this.uJitterSpeed.value,
      thicknessVariation: this.uThicknessVariation.value,
      color: "#1a1410",
    };

    folder.add(params, "thickness", 0, 0.1, 0.001).onChange((v) => {
      this.uThickness.value = v;
    });
    folder.add(params, "jitterAmount", 0, 0.05, 0.0005).onChange((v) => {
      this.uJitterAmount.value = v;
    });
    folder.add(params, "jitterSpeed", 1, 30, 1).onChange((v) => {
      this.uJitterSpeed.value = v;
    });
    folder.add(params, "thicknessVariation", 0, 1, 0.01).onChange((v) => {
      this.uThicknessVariation.value = v;
    });
    folder.addColor(params, "color").onChange((v) => {
      this.uColor.value.set(v);
    });

    folder.close();
    return folder;
  }
}
