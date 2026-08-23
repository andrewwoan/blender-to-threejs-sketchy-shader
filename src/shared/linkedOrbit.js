import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * One orbit for both panes.
 *
 * Each pane owns its own canvas and its own camera, so each gets its own
 * OrbitControls — that is what makes either half draggable. They are then kept
 * in lockstep by mirroring whichever one the pointer is driving onto the others.
 *
 * Mirroring copies POSITION and TARGET, not the camera's rotation. OrbitControls
 * derives its spherical state from `position - target` at the top of every
 * `update()` and ends by calling `lookAt(target)`, so handing it those two
 * vectors is enough — it works the orientation out itself, and there is no
 * second source of truth to drift.
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
    // Panning off: both panes have to keep framing the same thing for the
    // comparison to mean anything, and orbit + dolly is all this scene needs.
    orbit.enablePan = false;
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
