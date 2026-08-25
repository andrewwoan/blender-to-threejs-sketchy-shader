import * as THREE from "three/webgpu";

/**
 * Edge -> face adjacency for a mesh, built once and reused every tick.
 *
 * This is the table Blender's Line Art builds before it can classify anything,
 * and it is why an object-space contour is possible at all: to ask "is this edge
 * a silhouette" you need the TWO FACES either side of it, and a vertex buffer
 * does not carry that. Nothing here is view-dependent, so it is pure setup -
 * per frame we only re-test the faces we found here.
 *
 * The welding matters as much as the adjacency, for the reason a cube has 24
 * vertices rather than 8: an exported mesh is split wherever normals or UVs
 * differ, so the "same" edge exists two or three times over with no two copies
 * sharing an index. Match on rounded POSITION and the topology comes back.
 * Method A's `smoothNormals` does the same welding for the same underlying
 * reason - it wants one outward direction per corner, this wants one edge per
 * crease.
 */

/** Positions rarely match bit-for-bit in a float buffer; 3 decimals is plenty. */
const WELD_PRECISION = 1000;

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {number} creaseAngle  radians; dihedral angles sharper than this are
 *   marked as crease edges up front, since the angle never changes.
 */
export function buildEdgeTopology(geometry, creaseAngle = 0.7) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const triCount = (index ? index.count : position.count) / 3;

  // --- Weld vertices by position ---
  const weldMap = new Map();
  const remap = new Int32Array(position.count);
  const welded = [];

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x * WELD_PRECISION)},${Math.round(
      y * WELD_PRECISION,
    )},${Math.round(z * WELD_PRECISION)}`;

    let id = weldMap.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      weldMap.set(key, id);
      welded.push(x, y, z);
    }
    remap[i] = id;
  }

  const localPositions = new Float32Array(welded);
  const vertexCount = localPositions.length / 3;

  // --- Triangles, in welded indices ---
  const triangles = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const raw = index ? index.getX(t * 3 + c) : t * 3 + c;
      triangles[t * 3 + c] = remap[raw];
    }
  }

  // --- Edge table ---
  //
  // Keyed on the ordered vertex pair, so the same edge reached from either of
  // its two triangles lands in the same slot. A third face on one edge means
  // non-manifold geometry; it is dropped rather than handled, because a
  // silhouette test on "which of three faces" has no defined answer.
  const edgeMap = new Map();
  const edgeA = [];
  const edgeB = [];
  const edgeF0 = [];
  const edgeF1 = [];

  const addEdge = (a, b, face) => {
    if (a === b) return; // degenerate after welding
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * vertexCount + hi;

    const existing = edgeMap.get(key);
    if (existing === undefined) {
      edgeMap.set(key, edgeA.length);
      edgeA.push(lo);
      edgeB.push(hi);
      edgeF0.push(face);
      edgeF1.push(-1);
    } else if (edgeF1[existing] === -1) {
      edgeF1[existing] = face;
    }
  };

  for (let t = 0; t < triCount; t++) {
    const a = triangles[t * 3 + 0];
    const b = triangles[t * 3 + 1];
    const c = triangles[t * 3 + 2];
    addEdge(a, b, t);
    addEdge(b, c, t);
    addEdge(c, a, t);
  }

  // --- Static crease classification ---
  //
  // The dihedral angle is a property of the mesh, not the camera, so it is
  // resolved here once. Only the VISIBILITY of a crease changes per frame.
  const localNormals = new Float32Array(triCount * 3);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();

  const readVertex = (target, id) =>
    target.fromArray(localPositions, id * 3);

  for (let t = 0; t < triCount; t++) {
    readVertex(va, triangles[t * 3 + 0]);
    readVertex(vb, triangles[t * 3 + 1]);
    readVertex(vc, triangles[t * 3 + 2]);
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    n.crossVectors(ab, ac).normalize();
    n.toArray(localNormals, t * 3);
  }

  const edgeCount = edgeA.length;
  const isCrease = new Uint8Array(edgeCount);
  const cosThreshold = Math.cos(creaseAngle);
  const n0 = new THREE.Vector3();
  const n1 = new THREE.Vector3();

  for (let e = 0; e < edgeCount; e++) {
    const f1 = edgeF1[e];
    if (f1 === -1) continue; // boundary edge, handled as contour per frame

    n0.fromArray(localNormals, edgeF0[e] * 3);
    n1.fromArray(localNormals, f1 * 3);
    if (n0.dot(n1) < cosThreshold) isCrease[e] = 1;
  }

  return {
    localPositions,
    triangles,
    triCount,
    vertexCount,
    edgeCount,
    edgeA: new Int32Array(edgeA),
    edgeB: new Int32Array(edgeB),
    edgeF0: new Int32Array(edgeF0),
    edgeF1: new Int32Array(edgeF1),
    isCrease,

    // Scratch, reused every tick so a per-frame solve allocates nothing.
    worldPositions: new Float32Array(localPositions.length),
    faceNormals: new Float32Array(triCount * 3),
    faceFacing: new Float32Array(triCount),
  };
}

/**
 * Refresh the world-space positions, face normals and per-face facing sign for
 * one mesh. `facing` is the dot of the face normal with the direction from the
 * camera to the face: negative means the face points back at the camera.
 */
export function updateWorldState(topology, matrixWorld, cameraPosition) {
  const {
    localPositions,
    worldPositions,
    triangles,
    triCount,
    faceNormals,
    faceFacing,
  } = topology;

  const v = new THREE.Vector3();
  for (let i = 0; i < localPositions.length; i += 3) {
    v.fromArray(localPositions, i).applyMatrix4(matrixWorld);
    v.toArray(worldPositions, i);
  }

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const toFace = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    va.fromArray(worldPositions, triangles[t * 3 + 0] * 3);
    vb.fromArray(worldPositions, triangles[t * 3 + 1] * 3);
    vc.fromArray(worldPositions, triangles[t * 3 + 2] * 3);

    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    n.crossVectors(ab, ac).normalize();
    n.toArray(faceNormals, t * 3);

    // Centroid is enough: a triangle small against its distance to the camera
    // has effectively one facing, and using it avoids a per-vertex test that
    // would only disagree on triangles spanning the silhouette anyway.
    toFace
      .set(
        (va.x + vb.x + vc.x) / 3,
        (va.y + vb.y + vc.y) / 3,
        (va.z + vb.z + vc.z) / 3,
      )
      .sub(cameraPosition);

    faceFacing[t] = n.dot(toFace);
  }
}

/**
 * Which edges are feature lines this frame.
 *
 * CONTOUR is the whole reason this method exists, and it is one sign test: an
 * edge is on the silhouette when the faces either side of it disagree about
 * facing the camera. Not detected from an image, not approximated - the exact
 * boundary, in world space, at whatever precision the mesh has.
 *
 * Boundary edges (one adjacent face, like the open rim of a plane) count as
 * contour when their single face is visible.
 *
 * CREASE was classified at build time; here it only has to be visible, meaning
 * at least one of its faces points at the camera.
 *
 * @returns {Int32Array} indices into the edge table.
 */
export function selectFeatureEdges(topology, { contour = true, crease = true }) {
  const { edgeCount, edgeF0, edgeF1, faceFacing, isCrease } = topology;
  const selected = [];

  for (let e = 0; e < edgeCount; e++) {
    const f0 = edgeF0[e];
    const f1 = edgeF1[e];

    if (f1 === -1) {
      if (contour && faceFacing[f0] < 0) selected.push(e);
      continue;
    }

    const front0 = faceFacing[f0] < 0;
    const front1 = faceFacing[f1] < 0;

    if (contour && front0 !== front1) {
      selected.push(e);
    } else if (crease && isCrease[e] && (front0 || front1)) {
      selected.push(e);
    }
  }

  return Int32Array.from(selected);
}
