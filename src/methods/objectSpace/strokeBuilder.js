import * as THREE from "three/webgpu";

/**
 * Feature edges -> chained strokes -> a segment buffer, with the pencil lifts
 * placed along ARC LENGTH.
 *
 * Chaining is the step that makes this method worth the trouble. An edge pass
 * produces a per-pixel mask with no notion of the contour as a curve, so
 * anything "along the stroke" has to be faked with a screen-space noise field
 * that happens to intersect the line. Once the contour is a POLYLINE with a
 * measured length, "lift the pencil 40% of the way along this stroke" stops
 * being an approximation and becomes a lookup.
 *
 * Three things fall out of that which method B cannot reach at all:
 *
 *  - Gaps are measured in WORLD UNITS along the stroke, so they keep their
 *    length as the camera moves and do not slide over the surface.
 *  - Every chain gets its own seed, so two contours crossing the same patch of
 *    screen break independently. In screen space they share a noise field and
 *    break together, which reads as a texture laid over the drawing.
 *  - The ends of a stroke are known, so lifts can be kept away from them - a
 *    contour that dissolves at the exact point it should turn a corner reads as
 *    a mistake rather than as a lift.
 */

/** Integer hash. Cheaper than a sin() and there are eight of these per sample. */
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Remap the raw field to an approximately UNIFORM 0..1.
 *
 * Value noise is not uniform and neither is a sum of octaves: trilinear
 * interpolation and averaging both pull toward the mean, so the raw field is a
 * bell centred on 0.5 that never leaves roughly 0.20..0.78. Thresholding that
 * directly makes the whole bottom 40% of the `lift` control dead - the cut sits
 * below the field's floor and removes nothing - and then the useful range is a
 * cliff, going from untouched to fully erased across about 0.2 of slider travel.
 *
 * A smoothstep centred on the mean is a serviceable normal CDF, and pushing a
 * bell-distributed variable through its own CDF is exactly what flattens it. The
 * bounds are the measured mean +/- 2 sigma. After this, `lift` reads as the
 * fraction of the contour removed, near enough: 0.5 takes away 51%.
 */
const FIELD_LO = 0.27;
const FIELD_HI = 0.73;

function uniformize(v) {
  const t = Math.min(1, Math.max(0, (v - FIELD_LO) / (FIELD_HI - FIELD_LO)));
  return t * t * (3 - 2 * t);
}

/** Trilinear value noise. Smooth, so gaps have soft ends rather than hard edges. */
function noise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const mix = (a, b, t) => a + (b - a) * t;

  const x00 = mix(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux);
  const x10 = mix(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux);
  const x01 = mix(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux);
  const x11 = mix(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux);

  return mix(mix(x00, x10, uy), mix(x01, x11, uy), uz);
}

/**
 * Link selected edges into polylines.
 *
 * Walks from every vertex that is NOT a simple through-point first, so open
 * chains come out whole rather than being entered in the middle and emitted as
 * two halves - which would put a seam, and a possible lift, at an arbitrary
 * spot. Closed loops have no such vertex and are picked up in the second pass.
 */
export function chainEdges(topology, selectedEdges) {
  const { edgeA, edgeB, worldPositions } = topology;

  // Direction of `edge` leaving `vertex`, normalised. Used to decide which way a
  // chain should carry on when more than two feature edges meet.
  const dirFrom = (edge, vertex, target) => {
    const far = edgeA[edge] === vertex ? edgeB[edge] : edgeA[edge];
    target
      .set(
        worldPositions[far * 3] - worldPositions[vertex * 3],
        worldPositions[far * 3 + 1] - worldPositions[vertex * 3 + 1],
        worldPositions[far * 3 + 2] - worldPositions[vertex * 3 + 2],
      )
      .normalize();
    return target;
  };

  const incident = new Map();
  const attach = (vertex, edge) => {
    let list = incident.get(vertex);
    if (list === undefined) incident.set(vertex, (list = []));
    list.push(edge);
  };

  for (let i = 0; i < selectedEdges.length; i++) {
    const e = selectedEdges[i];
    attach(edgeA[e], e);
    attach(edgeB[e], e);
  }

  const used = new Uint8Array(topology.edgeCount);
  const chains = [];

  const other = (edge, vertex) =>
    edgeA[edge] === vertex ? edgeB[edge] : edgeA[edge];

  const walk = (startVertex, startEdge) => {
    const points = [startVertex];
    let vertex = startVertex;
    let edge = startEdge;

    for (;;) {
      used[edge] = 1;
      vertex = other(edge, vertex);
      points.push(vertex);

      const candidates = incident.get(vertex);
      if (!candidates || candidates.length < 2) break;

      // Carry on through a JUNCTION rather than stopping at it.
      //
      // Stopping was the obvious reading - at a fork there is no single "next"
      // edge - but it is wrong, and expensively so. On a cube every corner is a
      // fork the moment creases are on, so the outline came apart into one chain
      // per edge: two points each, which is below the minimum Chaikin needs and
      // therefore silently unsmoothable. That is the "half the time it is not
      // rounded" - it was never rounded on the cube at all, only on the sphere,
      // whose silhouette has no junctions.
      //
      // The tie-break is the same one a hand makes: carry straight on. Of the
      // unused edges at this vertex, take the one whose direction best continues
      // the one we arrived along. Blender's Line Art chains across junctions on
      // the same principle, and splits instead at a "turning point" angle.
      dirFrom(edge, vertex, _dirIn).negate();

      let next = -1;
      let straightest = -Infinity;
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c];
        if (candidate === edge || used[candidate]) continue;

        const alignment = _dirIn.dot(dirFrom(candidate, vertex, _dirOut));
        if (alignment > straightest) {
          straightest = alignment;
          next = candidate;
        }
      }

      if (next === -1) break;
      edge = next;
    }

    return points;
  };

  // Open chains, entered from their ends.
  for (const [vertex, list] of incident) {
    if (list.length === 2) continue;
    for (const edge of list) {
      if (used[edge]) continue;
      chains.push(walk(vertex, edge));
    }
  }

  // Whatever is left is a closed loop.
  for (let i = 0; i < selectedEdges.length; i++) {
    const edge = selectedEdges[i];
    if (used[edge]) continue;
    chains.push(walk(edgeA[edge], edge));
  }

  return chains;
}

/**
 * Chaikin corner cutting: round the chain instead of the model.
 *
 * The instinct when a cube's outline comes out with hard corners is to bevel the
 * cube - but that changes the OBJECT, and the object is not what is wrong. An
 * illustrator drawing a box does not round the box; their hand rounds the
 * stroke, because a pencil cannot instantaneously reverse direction. So the
 * rounding belongs to the polyline, where it costs nothing, touches no shading,
 * and can be dialled per pane.
 *
 * Each pass replaces every point with two points set in from it along its
 * neighbouring segments, which converges on a quadratic B-spline. `amount`
 * scales the classic 1/4 cut, so 0 leaves the chain alone and 1 is full Chaikin.
 *
 * Closed loops cut every corner cyclically. Open chains keep their first and
 * last points pinned - those are real stroke ends, and pulling them inward would
 * shorten the contour a little more with every pass.
 *
 * Blender exposes the same idea on the Line Art modifier as "Smooth Jagged
 * Chains", and for the same reason: chaining is what makes it possible at all.
 */
const SMOOTH_PASSES = 2;

function smoothChain(flat, closed, amount) {
  const r = Math.min(0.49, amount * 0.25);
  if (r <= 0) return flat;

  let src = flat;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const n = src.length / 3;
    if (n < 3) return src;

    const out = [];
    const cut = (a, b, t) => {
      for (let c = 0; c < 3; c++) out.push(src[a + c] * (1 - t) + src[b + c] * t);
    };

    if (!closed) out.push(src[0], src[1], src[2]);

    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = i * 3;
      const b = (closed ? (i + 1) % n : i + 1) * 3;
      cut(a, b, r);
      cut(a, b, 1 - r);
    }

    if (!closed) {
      const end = (n - 1) * 3;
      out.push(src[end], src[end + 1], src[end + 2]);
    }

    src = out;
  }

  return src;
}

const _dirIn = new THREE.Vector3();
const _dirOut = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _lq = new THREE.Vector3();
const _toCamera = new THREE.Vector3();

/**
 * Turn chains into a flat [x1,y1,z1, x2,y2,z2, ...] segment buffer.
 *
 * @param {object[]} meshChains  `{ topology, chains }` per mesh
 * @param {THREE.Vector3} cameraPosition
 * @param {object} options
 * @param {number[]} out  segment endpoints, 6 floats per segment
 */
export function buildStrokeSegments(meshChains, cameraPosition, options, out) {
  const {
    maxSegment,
    lift,
    liftScale,
    endGuard,
    depthBias,
    cornerRounding,
    pose,
  } = options;

  out.length = 0;

  // One offset per stop-motion pose, shared by every stroke in the frame. This
  // is the ONLY thing that re-rolls the lifts, which is the whole point: within
  // a pose the field is frozen, so nothing can shimmer between frames.
  const poseX = hash3(pose, 11, 23) * 128;
  const poseY = hash3(pose, 37, 51) * 128;
  const poseZ = hash3(pose, 71, 97) * 128;

  for (const { topology, chains } of meshChains) {
    const positions = topology.worldPositions;
    const locals = topology.localPositions;

    for (const chain of chains) {
      if (chain.length < 2) continue;

      // --- Resample to a fixed arc-length step ---
      //
      // Gaps can then start and end mid-edge instead of snapping to whatever
      // tessellation the mesh happens to have. Without this the lifts inherit
      // the model's topology, and a dense torus knot and a 12-triangle cube
      // would break up at completely different rates.
      //
      // LOCAL positions are carried alongside the world ones, interpolated at
      // the same parameter. They are what the lift field is sampled in - see
      // below.
      // Gather the chain as raw positions, world and local in step.
      const rawWorld = [];
      const rawLocal = [];
      for (let i = 0; i < chain.length; i++) {
        const v = chain[i] * 3;
        rawWorld.push(positions[v], positions[v + 1], positions[v + 2]);
        rawLocal.push(locals[v], locals[v + 1], locals[v + 2]);
      }

      // Round BEFORE resampling, so the arc length that the lifts and the end
      // guard are measured against is the length of the curve actually drawn.
      // A chain whose first and last vertex coincide is a closed loop and has no
      // ends to pin.
      const closed = chain[0] === chain[chain.length - 1];
      const world = smoothChain(rawWorld, closed, cornerRounding);
      const local = smoothChain(rawLocal, closed, cornerRounding);

      const points = [];
      const localPoints = [];
      const arc = [];
      let total = 0;

      points.push(world[0], world[1], world[2]);
      localPoints.push(local[0], local[1], local[2]);
      arc.push(0);

      const pointCount = world.length / 3;
      for (let i = 1; i < pointCount; i++) {
        const a = (i - 1) * 3;
        const b = i * 3;
        _p.set(world[a], world[a + 1], world[a + 2]);
        _q.set(world[b], world[b + 1], world[b + 2]);
        _lp.set(local[a], local[a + 1], local[a + 2]);
        _lq.set(local[b], local[b + 1], local[b + 2]);

        const length = _p.distanceTo(_q);
        const steps = Math.max(1, Math.ceil(length / maxSegment));

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          points.push(
            _p.x + (_q.x - _p.x) * t,
            _p.y + (_q.y - _p.y) * t,
            _p.z + (_q.z - _p.z) * t,
          );
          localPoints.push(
            _lp.x + (_lq.x - _lp.x) * t,
            _lp.y + (_lq.y - _lp.y) * t,
            _lp.z + (_lq.z - _lp.z) * t,
          );
          total += length / steps;
          arc.push(total);
        }
      }

      if (arc.length < 2 || total <= 0) continue;

      // --- Where the pencil is down ---
      //
      // The field is sampled in the mesh's OWN coordinate system, and that is
      // what fixes the spinning objects.
      //
      // Sampling it by arc length needed two things that a rotating mesh does
      // not have: a stroke identity that survives from frame to frame, and a
      // stable point to measure length from. Neither exists. Rotate a cube and
      // the contour is a genuinely different curve every frame - chains split
      // and merge, endpoints appear, and any seed derived from them re-rolls at
      // frame rate however slowly the boil is set. The static sphere hid the bug
      // completely, because nothing about it ever moved.
      //
      // Anchoring to local position removes the question. A point on the model
      // has one lift value, decided by where it sits on the model and by the
      // pose - not by which chain happened to contain it, or which end that
      // chain was walked from. As the object turns, the silhouette sweeps across
      // a field that is rotating with it, so gaps drift on and off the contour
      // smoothly instead of being redrawn from scratch.
      //
      // The gaps are still measured in world units and still uncorrelated
      // between strokes, which were the two things arc length was buying. What
      // is genuinely given up is a gap whose LENGTH along the stroke is
      // controlled directly; here it falls out of how the contour happens to
      // cross the field, exactly as it does for method B - the difference being
      // that this field is attached to the model rather than to the screen.
      // Signed distance from the threshold, NOT a 0/1 flag. Keeping the sign and
      // the magnitude is what lets the emit step below solve for the exact point
      // the pencil leaves the paper.
      const margin = new Array(arc.length);
      for (let i = 0; i < arc.length; i++) {
        const lx = localPoints[i * 3] * liftScale + poseX;
        const ly = localPoints[i * 3 + 1] * liftScale + poseY;
        const lz = localPoints[i * 3 + 2] * liftScale + poseZ;

        // Two octaves, so gaps come in mixed lengths rather than a regular
        // dotted rhythm - the same reason B's lift field is layered.
        const field = uniformize(
          noise3(lx, ly, lz) * 0.65 +
            noise3(lx * 2.7 + 31.7, ly * 2.7, lz * 2.7) * 0.35,
        );

        // Taper the lift amount to zero near both ends of the stroke, so a
        // contour never dissolves exactly where it should be turning a corner.
        // Arc length is still used here, and safely: it is symmetric about the
        // middle, so it does not care which end the chain was walked from.
        const s = arc[i];
        const fromEnd = Math.min(s, total - s);
        const guard = endGuard > 0 ? Math.min(1, fromEnd / endGuard) : 1;

        margin[i] = field - lift * guard;
      }

      // --- Emit what survives, trimmed to the exact crossing ---
      //
      // An earlier attempt faded the ink toward the paper colour through the
      // vertex colour, to give `lift softness` something to do. That was wrong
      // for a reason worth recording: a fat line has no per-vertex alpha, so
      // "fading" could only mean blending toward a FLAT paper tone - which over
      // a dark object paints a pale streak rather than removing anything. The
      // gaps came out white.
      //
      // A gap should be absence, not pale ink. So there is no fade and no
      // softness control; instead the endpoint is moved to where the field
      // actually crosses the threshold. The gap edge lands exactly there rather
      // than snapping to the nearest resample step, which is a sharper result
      // than the fade was ever going to give.
      for (let i = 1; i < arc.length; i++) {
        const m0 = margin[i - 1];
        const m1 = margin[i];
        if (m0 <= 0 && m1 <= 0) continue;

        // Linear solve for margin == 0. Guarded by the test above: at least one
        // end is positive, so m0 - m1 cannot be zero when either t is needed.
        const t0 = m0 > 0 ? 0 : m0 / (m0 - m1);
        const t1 = m1 > 0 ? 1 : m0 / (m0 - m1);

        const a = (i - 1) * 3;
        const b = i * 3;

        for (const t of [t0, t1]) {
          _p.set(
            points[a] + (points[b] - points[a]) * t,
            points[a + 1] + (points[b + 1] - points[a + 1]) * t,
            points[a + 2] + (points[b + 2] - points[a + 2]) * t,
          );

          // Nudge toward the camera. A contour lies exactly ON the surface it
          // bounds, so without this it z-fights with the mesh it belongs to and
          // the stroke stipples in and out as the object turns.
          _toCamera.subVectors(cameraPosition, _p).normalize();
          out.push(
            _p.x + _toCamera.x * depthBias,
            _p.y + _toCamera.y * depthBias,
            _p.z + _toCamera.z * depthBias,
          );
        }
      }
    }
  }

  return out;
}
