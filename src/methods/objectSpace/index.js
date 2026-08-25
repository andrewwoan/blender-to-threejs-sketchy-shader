import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { createDummyScene, createLighting } from "../../shared/dummyScene.js";
import { createPaperGrade } from "../../shared/paperGrade.js";
import {
  createSketchMaterial,
  updateSketchFlicker,
} from "../blenderSketch/sketchMaterial.js";
import {
  buildEdgeTopology,
  updateWorldState,
  selectFeatureEdges,
} from "./edgeTopology.js";
import { chainEdges, buildStrokeSegments } from "./strokeBuilder.js";
import { QUALITY } from "../../shared/quality.js";

/**
 * METHOD D - the outline as ANALYTIC CONTOURS, the way Blender's Grease Pencil
 * Line Art does it. Object-space, not image-space.
 *
 * D deliberately runs C's hatching unchanged, so the pair isolates exactly one
 * variable. B vs C is two hatchings behind one outline; C vs D is one hatching
 * behind two outlines.
 *
 * The pipeline, per solve:
 *
 *   1. WORLD STATE  - push each mesh's welded vertices through its matrix and
 *      work out which way every face points relative to the camera.
 *   2. CLASSIFY     - an edge is a contour when the faces either side disagree
 *      about facing. That is the exact silhouette, computed rather than
 *      detected: no threshold to tune, no resolution to run out of, and it is
 *      correct at the frame's edge where a screen-space stencil has no data.
 *   3. CHAIN        - link the survivors into polylines, which is what gives
 *      every stroke a measurable length.
 *   4. EMIT         - resample along arc length, cut the lifts, write segments.
 *
 * Occlusion is the one stage NOT done the way Blender does it, and the swap is
 * what makes this real time at all. Line Art raycasts every edge against the
 * whole scene, which is why it is a bake rather than a viewport effect. Here the
 * strokes are real geometry in the scene, so the DEPTH BUFFER hides them - no
 * ray casts, no read-back, no stall, and it is exact.
 *
 * What that costs, honestly:
 *
 *  - No occlusion LEVELS. The depth buffer answers visible or hidden, not
 *    "behind exactly two surfaces", so hidden-line styling is off the table.
 *  - Lifts are placed without knowing what is visible, so a gap can be spent on
 *    a stretch that was hidden anyway.
 *  - No face intersections. Blender computes where triangles actually cross and
 *    emits new edges there; that needs a BVH pass this does not have. Your blend
 *    file has that option switched off too.
 */

/** Per mesh, allocated once. The torus knot is the one that needs the room. */
const MAX_SEGMENTS = 12000;

export function buildObjectSpacePane({ camera, gui }) {
  const world = createDummyScene({
    makeMaterial: (opts = {}) => createSketchMaterial(opts),
  });
  const lighting = createLighting(world.scene);

  const params = {
    contour: true,
    // Off, matching the Line Art modifier in the reference blend file. A crease
    // is a hard FOLD in the surface, not a silhouette - see the note by the
    // crease test in edgeTopology.js - and inking every fold turns a cube into a
    // wireframe box rather than a drawn one.
    crease: false,
    creaseAngle: 0.85, // radians
    lineWidth: 2.2,
    inkColor: "#1a1410",
    maxSegment: QUALITY.maxSegment,
    lift: 0.42,
    liftScale: 5.5,
    endGuard: 0.12,
    depthBias: 0.012,
    // Just enough to take the mechanical edge off the corners without turning a
    // cube into a pebble. Chaikin cuts toward the inside of every corner, so a
    // high value visibly shrinks a silhouette as well as softening it.
    cornerRounding: 0.1,
    solveHz: QUALITY.solveHz,
    // Stop-motion steps per second, matching every other pane's boil. This is a
    // DIFFERENT clock from `solveHz` and the distinction is the important one:
    // solveHz is how often the contour geometry is recomputed (must be fast, the
    // silhouette moves with the camera), boilSpeed is how often the hand redraws
    // (must be slow, or the lifts are noise rather than a boil).
    boilSpeed: 6,
  };

  // The ground is a single 48-unit quad. Its only feature edges are the four
  // boundary edges of the quad itself, which would ink an enormous rectangle
  // across the horizon - the same reason method A opts it out of the hull.
  const outlined = world.meshes.filter((mesh) => mesh !== world.ground);

  const lineMaterial = new THREE.Line2NodeMaterial({
    color: new THREE.Color(params.inkColor),
    linewidth: params.lineWidth, // screen pixels
    worldUnits: false,
    dashed: false,
  });

  // --- One stroke object per mesh, PARENTED to that mesh ---
  //
  // The obvious build is a single merged buffer of world-space segments, and it
  // works right up until the solve rate drops below the frame rate. Then a stale
  // stroke stays where the silhouette used to be while the mesh keeps turning:
  // it detaches, and the parts that end up inside the new surface are culled by
  // the depth buffer and pop back the next solve. That is the jitter, and it
  // appears only on objects that actually spin.
  //
  // Splitting per mesh and hanging each stroke object off its own mesh fixes it
  // with no per-frame work at all. The segments are written in LOCAL space, so
  // the scene graph carries them through the mesh's rotation exactly. The
  // silhouette SHAPE is still a little stale between solves - it was computed a
  // few degrees ago - but a slightly old outline that is welded to the object
  // reads as correct, where a current one sliding around on top of it does not.
  const buildTopology = (mesh) =>
    buildEdgeTopology(mesh.geometry, params.creaseAngle);

  const strokeSets = outlined.map((mesh) => {
    const data = new Float32Array(MAX_SEGMENTS * 6);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(data);
    geometry.instanceCount = 0;

    const lines = new LineSegments2(geometry, lineMaterial);
    lines.castShadow = false;
    lines.receiveShadow = false;
    // The buffer holds stale data past `instanceCount`, so its bounds are
    // meaningless - cull off the whole object rather than against a lie.
    lines.frustumCulled = false;
    mesh.add(lines);

    return { mesh, topology: buildTopology(mesh), data, geometry, segments: [] };
  });

  const grade = createPaperGrade();

  // No pre-pass and no edge detector: the outline is geometry, so the post chain
  // is the same minimal one method A uses.
  const scenePass = pass(world.scene, camera);
  const output = grade.vignette(grade.grade(scenePass.getTextureNode()));

  const cameraPosition = new THREE.Vector3();
  const localCamera = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  let elapsed = 0;
  let lastSolve = -Infinity;

  const solve = () => {
    camera.getWorldPosition(cameraPosition);
    const pose = Math.floor(elapsed * params.boilSpeed);

    for (const set of strokeSets) {
      set.mesh.updateWorldMatrix(true, false);

      // Facing is still decided in world space - it has to be, it is a question
      // about the camera - while the segments come back in local space.
      updateWorldState(set.topology, set.mesh.matrixWorld, cameraPosition);

      const selected = selectFeatureEdges(set.topology, {
        contour: params.contour,
        crease: params.crease,
      });

      const chains = chainEdges(set.topology, selected);

      // The depth bias nudges each stroke toward the viewer, so the camera has
      // to be expressed in the same space the segments are written in.
      inverse.copy(set.mesh.matrixWorld).invert();
      localCamera.copy(cameraPosition).applyMatrix4(inverse);

      buildStrokeSegments(
        [{ topology: set.topology, chains }],
        localCamera,
        {
          maxSegment: params.maxSegment,
          lift: params.lift,
          liftScale: params.liftScale,
          endGuard: params.endGuard,
          depthBias: params.depthBias,
          cornerRounding: params.cornerRounding,
          pose,
        },
        set.segments,
      );

      // Copied element-wise so an overflowing solve is clamped rather than
      // throwing, and so nothing allocates on the hot path.
      const floats = Math.min(set.segments.length, set.data.length);
      for (let i = 0; i < floats; i++) set.data[i] = set.segments[i];

      set.geometry.attributes.instanceStart.data.needsUpdate = true;
      set.geometry.instanceCount = floats / 6;
    }
  };

  setupGUI(gui, params, {
    lineMaterial,
    rebuildTopology: () => {
      for (const set of strokeSets) set.topology = buildTopology(set.mesh);
    },
  });

  return {
    scene: world.scene,
    lighting,
    // D shades off the real lit result, exactly as C does, so there is nothing
    // for the light rig to publish.
    syncLight: () => {},
    // The governor's ladder ends in a solve rate; 0 means "whatever quality.js
    // chose for this device", so full quality does not override a mobile
    // default that was already deliberate.
    setQuality: (solveHz) => {
      params.solveHz = solveHz === 0 ? QUALITY.solveHz : solveHz;
    },
    output,
    resize: (width, height) => grade.setAspect(width, height),
    update: (delta, elapsed) => {
      updateSketchFlicker(elapsed);
      world.update(delta);
      elapsed += delta;

      // Contours are view-dependent, so unlike the hatch boil this cannot simply
      // hold: the objects spin, and a held outline detaches from the shape it
      // belongs to. Solving every frame is the default; the rate is exposed
      // because dropping it to ~6 gives a genuinely stop-motion line that agrees
      // with the boil, and it is worth being able to see that.
      const interval = params.solveHz > 0 ? 1 / params.solveHz : 0;
      if (elapsed - lastSolve < interval) return;

      lastSolve = elapsed;
      solve();
    },
  };
}

function setupGUI(gui, params, { lineMaterial, rebuildTopology }) {
  const folder = gui.addFolder("D - Line art (object-space contours)");

  folder.add(params, "lineWidth", 0.25, 12, 0.05).name("width (px)").onChange((v) => {
    lineMaterial.linewidth = v;
  });
  folder
    .add(params, "cornerRounding", 0, 1, 0.01)
    .name("corner rounding");
  folder.addColor(params, "inkColor").name("ink colour").onChange((v) => {
    lineMaterial.color.set(v);
  });

  const edges = folder.addFolder("edge types");
  edges.add(params, "contour").name("contour");
  edges.add(params, "crease").name("crease");
  edges
    .add(params, "creaseAngle", 0.05, 2.0, 0.01)
    .name("crease angle (rad)")
    // Crease flags are baked into the topology, since the dihedral angle never
    // changes on its own - so moving this has to rebuild the table.
    .onChange(rebuildTopology);

  const hand = folder.addFolder("hand");
  hand.add(params, "lift", 0, 1, 0.01).name("pencil lifts");
  hand.add(params, "liftScale", 0.2, 30, 0.1).name("lifts per world unit");
  hand.add(params, "endGuard", 0, 1, 0.01).name("protect stroke ends");

  const solver = folder.addFolder("solver");
  solver.add(params, "maxSegment", 0.005, 0.2, 0.005).name("resample step");
  solver.add(params, "depthBias", 0, 0.06, 0.001).name("depth bias");
  solver
    .add(params, "solveHz", 0, 60, 1)
    .name("solve rate (0 = every frame)");

  hand.add(params, "boilSpeed", 0.5, 24, 0.5).name("boil (steps/sec)");

  folder.close();
  return folder;
}
