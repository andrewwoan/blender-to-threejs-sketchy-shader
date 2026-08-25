import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * One orbit for every pane.
 *
 * Each pane owns its own canvas and its own camera, so each gets its own
 * OrbitControls — that is what makes every pane draggable. They are then kept
 * in lockstep by mirroring whichever one the pointer is driving onto the others.
 *
 * Mirroring copies POSITION and TARGET, not the camera's rotation. OrbitControls
 * derives its spherical state from `position - target` at the top of every
 * `update()` and ends by calling `lookAt(target)`, so handing it those two
 * vectors is enough — it works the orientation out itself, and there is no
 * second source of truth to drift.
 *
 * That choice is also what makes panning free. Orbiting moves the position
 * about a fixed target; dollying changes their separation; panning translates
 * BOTH by the same offset. All three are fully described by the pair, so every
 * gesture mirrors through the same two lines and none of them needs a case of
 * its own here.
 *
 * The `syncing` latch is what stops the obvious feedback loop: writing to a
 * mirror makes IT emit `change`, which would write straight back.
 */
export function linkOrbitControls(panes, { target = [0, -0.15, 0] } = {}) {
  const focus = new THREE.Vector3(...target);
  let syncing = false;

  const controls = panes.map((pane) => {
    const orbit = new OrbitControls(pane.camera, pane.canvas);

    orbit.target.copy(focus);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    // Panning is on, and it stays honest for the same reason orbiting does: the
    // mirror below copies POSITION and TARGET, and a pan is precisely a matched
    // translation of both. So it needs no handling of its own - every pane pans
    // together, and they cannot drift out of a shared framing.
    //
    // Right-drag by default (OrbitControls' own `mouseButtons.RIGHT`), which
    // also suppresses the browser context menu on the canvas while the controls
    // are enabled. Left-drag still orbits, and the light gizmo is unaffected
    // because TransformControls ignores any button but the left one.
    orbit.enablePan = true;
    // Pan along the screen plane rather than the ground plane, so dragging up
    // moves the subject up rather than pushing it away from the camera. This is
    // the OrbitControls default; it is set explicitly because it is the
    // behaviour the framing here assumes.
    orbit.screenSpacePanning = true;
    orbit.panSpeed = 0.8;
    orbit.minDistance = 3.5;
    orbit.maxDistance = 16;
    orbit.minPolarAngle = 0.25;
    // Stop just short of horizontal, so the camera never drops through the floor
    // and looks up at the underside of the ground plane.
    orbit.maxPolarAngle = Math.PI * 0.49;
    orbit.rotateSpeed = 0.6;
    orbit.zoomSpeed = 0.7;
    orbit.update();

    return orbit;
  });

  for (const source of controls) {
    source.addEventListener("change", () => {
      if (syncing) return;
      syncing = true;

      for (const other of controls) {
        if (other === source) continue;
        other.object.position.copy(source.object.position);
        other.target.copy(source.target);
        other.update();
      }

      syncing = false;
    });
  }

  return {
    controls,
    // Damping means the orbit keeps easing after the pointer is released, so
    // this has to run every frame, not only on input.
    update: () => {
      for (const orbit of controls) orbit.update();
    },
    dispose: () => {
      for (const orbit of controls) orbit.dispose();
    },
  };
}
