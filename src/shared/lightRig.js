import * as THREE from "three/webgpu";
import { TransformControls } from "three/addons/controls/TransformControls.js";

/**
 * One key light, dragged with a gizmo, driving both panes at once.
 *
 * The lighting is the thing you most want to move while judging a hatching
 * technique — where the ink starts is entirely a function of the light — and
 * typing numbers into a slider is a bad way to find an angle. So the light and
 * its target get a real transform gizmo, and both scenes follow it.
 *
 * The gizmo itself lives in ONE pane (the left). Two gizmos, one per pane, would
 * mean two things claiming to be the truth and a sync loop to arbitrate between
 * them; a single handle that both lights read from has no such problem. The
 * light HELPERS are drawn in both, so you can see the light from either side.
 */

// Helpers and gizmo live off the default layer, so method B's pre-pass can skip
// them - see the note in createLightRig. The cameras opt back into it, so they
// still show up in the ordinary colour pass.
export const HELPER_LAYER = 20;

export function createLightRig({ panes, lightings, syncs, orbit, gui }) {
  const host = panes[0];
  const key = lightings[0].key;

  // Two proxies the gizmo actually moves. The lights are followers, not the
  // source of truth, which keeps "both panes agree" trivially true.
  const lightHandle = new THREE.Object3D();
  lightHandle.position.copy(key.position);

  const targetHandle = new THREE.Object3D();
  targetHandle.position.copy(key.target.position);

  host.scene.add(lightHandle, targetHandle);

  // --- Helpers, one set per pane ---
  const helpers = panes.map((pane, i) => {
    const light = new THREE.DirectionalLightHelper(lightings[i].key, 0.5, 0x1a1410);
    const frustum = new THREE.CameraHelper(lightings[i].key.shadow.camera);
    frustum.visible = false;

    for (const helper of [light, frustum]) {
      helper.traverse((object) => object.layers.set(HELPER_LAYER));
      pane.scene.add(helper);
    }

    pane.camera.layers.enable(HELPER_LAYER);
    return { light, frustum };
  });

  // --- The gizmo ---
  const gizmo = new TransformControls(host.camera, host.canvas);
  gizmo.size = 0.7;
  gizmo.attach(lightHandle);

  // Deliberately NOT moved onto HELPER_LAYER, unlike the light helpers.
  // TransformControls hit-tests with its own Raycaster, and a Raycaster only
  // tests layer 0 unless told otherwise - move the picker meshes off it and the
  // gizmo still draws but silently stops responding to the pointer. It can stay
  // on the default layer because the pane hosting it has no pre-pass to pollute.
  host.scene.add(gizmo.getHelper());

  // Orbit and the gizmo both want the drag. Whoever grabbed first wins.
  gizmo.addEventListener("dragging-changed", (event) => {
    for (const control of orbit.controls) control.enabled = !event.value;
  });

  const state = { handle: "light", visible: true, frustum: false };

  setupGUI({ gui, gizmo, lightings, helpers, state, lightHandle, targetHandle });

  return {
    lightHandle,
    targetHandle,
    gizmo,
    /** Push the handles onto every light, then re-derive the hatch direction. */
    update: () => {
      for (const { key: light } of lightings) {
        light.position.copy(lightHandle.position);
        light.target.position.copy(targetHandle.position);
        // The target is a plain Object3D that nothing else renders, so nothing
        // else will update its matrix - and the light's direction is derived
        // from it. Miss this and the shadow lags a frame behind the gizmo.
        light.target.updateMatrixWorld();
      }

      // Each method keeps the light direction in its own uniform set.
      for (const sync of syncs) sync();

      for (const { light, frustum } of helpers) {
        light.update();
        if (frustum.visible) frustum.update();
      }
    },
    dispose: () => {
      gizmo.detach();
      gizmo.dispose();
    },
  };
}

function setupGUI({ gui, gizmo, lightings, helpers, state, lightHandle, targetHandle }) {
  const folder = gui.addFolder("Light (both panes)");

  const key = lightings[0].key;
  const params = {
    intensity: key.intensity,
    ambient: lightings[0].ambient.intensity,
    colour: "#" + key.color.getHexString(),
  };

  folder
    .add(state, "handle", { "light position": "light", "light target": "target" })
    .name("gizmo controls")
    .onChange((v) => gizmo.attach(v === "light" ? lightHandle : targetHandle));

  folder
    .add(params, "intensity", 0, 6, 0.05)
    .name("key intensity")
    .onChange((v) => {
      for (const { key: light } of lightings) light.intensity = v;
    });

  folder
    .add(params, "ambient", 0, 4, 0.05)
    .name("ambient intensity")
    .onChange((v) => {
      for (const { ambient } of lightings) ambient.intensity = v;
    });

  folder
    .addColor(params, "colour")
    .name("key colour")
    .onChange((v) => {
      for (const { key: light, ambient } of lightings) {
        light.color.set(v);
        ambient.color.set(v);
      }
    });

  folder
    .add(state, "visible")
    .name("show light helper")
    .onChange((v) => {
      gizmo.getHelper().visible = v;
      gizmo.enabled = v;
      for (const { light } of helpers) light.visible = v;
    });

  folder
    .add(state, "frustum")
    .name("show shadow frustum")
    .onChange((v) => {
      for (const { frustum } of helpers) frustum.visible = v;
    });

  folder.close();
  return folder;
}
