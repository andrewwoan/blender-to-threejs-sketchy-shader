import * as THREE from "three/webgpu";
import { createInspector, createInspectorGui } from "./inspectorGui.js";
import { QUALITY } from "./quality.js";

// The box the camera must always contain, in world units at the subject's
// distance, and how far back it sits. See Pane.resize.
const CAMERA_DISTANCE = 8.0;
const FRAME_HALF_WIDTH = 2.7;
const FRAME_HALF_HEIGHT = 2.1;

/**
 * One half of the split screen: a canvas, a WebGPU renderer, a camera, and a
 * render loop. Everything specific to a method is supplied by the method module
 * through `build`.
 *
 * Two renderers rather than one renderer with a scissor. Method B's outline is
 * a post-processing pipeline over its own multi-target pre-pass, so the two
 * halves cannot share a framebuffer without one of them rendering into a target
 * and being blitted back — which is more moving parts than the comparison is
 * worth. Two devices costs a little memory and keeps each method a
 * self-contained thing you can lift straight out of this repo.
 */
export class Pane {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {(ctx: {renderer, camera, pane, gui}) => object} opts.build  Returns
   *   `{ scene, output, update?, resize? }`. `output` is the TSL node the
   *   pipeline renders; `update(delta, elapsed)` runs before each frame.
   * @param {boolean} [opts.inspector]  Host the Inspector panel on this pane's
   *   renderer and build the shared control group from it. Exactly one pane
   *   should set this - see the note in main.js.
   * @param {object} [opts.gui]  The group built by the hosting pane, for panes
   *   that draw into someone else's panel.
   */
  constructor({ canvas, build, inspector = false, gui = null }) {
    this.canvas = canvas;
    // Multiplier the performance governor drives, on top of whatever quality.js
    // chose for this device. 1 until something is measured to be too slow.
    this.qualityScale = 1;
    this.build = build;
    this.hostsInspector = inspector;
    this.gui = gui;
    this.timer = new THREE.Timer();
  }

  async init() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.width = width;
    this.height = height;
    this.pixelRatio =
      Math.min(window.devicePixelRatio, QUALITY.pixelRatio) * this.qualityScale;

    this.renderer = new THREE.WebGPURenderer({
      canvas: this.canvas,
      antialias: QUALITY.antialias,
    });

    // Before init(), not after - see createInspector for why that ordering is
    // load-bearing.
    if (this.hostsInspector) this.renderer.inspector = createInspector();

    await this.renderer.init();

    if (this.hostsInspector) {
      this.gui = createInspectorGui(this.renderer, "hatch & outline lab");
    }

    // The hatch IS the shading. Tone mapping on top of it re-grades a ramp that
    // was chosen by hand, so it stays off in both methods.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    // VSM, not Basic or PCF. The drawn shadow needs to know how DEEP into the
    // shadow each fragment is, and only a blurred shadow map gives a gradient to
    // read - Basic is binary, and PCF's penumbra is a couple of shadow-map texels
    // wide, far too narrow to grade a pencil falloff across.
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(this.pixelRatio);

    this.camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    this.camera.position.set(0, 1.5, CAMERA_DISTANCE);
    this.camera.lookAt(0, -0.15, 0);

    const built = this.build({
      renderer: this.renderer,
      camera: this.camera,
      pane: this,
      gui: this.gui,
    });

    this.scene = built.scene;
    this.onUpdate = built.update ?? null;
    this.onResize = built.resize ?? null;

    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = built.output;

    this.resize(width, height);
    return built;
  }

  resize(width, height) {
    if (!this.renderer || width === 0 || height === 0) return;

    this.width = width;
    this.height = height;
    this.pixelRatio =
      Math.min(window.devicePixelRatio, QUALITY.pixelRatio) * this.qualityScale;

    // Contain-fit the framing box, rather than leaving the vertical FOV fixed.
    //
    // A three.js camera holds vertical FOV constant and crops the sides, so on a
    // split screen the objects walk out of frame the moment the window is not
    // wide — and on a very wide pane they shrink into the middle of an ocean of
    // ground. Solving for whichever of the two half-extents needs the taller
    // frustum keeps the same composition at any pane shape.
    const aspect = width / height;
    this.camera.aspect = aspect;

    const halfHeight = Math.max(FRAME_HALF_HEIGHT, FRAME_HALF_WIDTH / aspect);
    this.camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(halfHeight / CAMERA_DISTANCE),
    );
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);

    this.onResize?.(width, height);
  }

  /**
   * Re-scale the drawing buffer without touching the layout. Re-runs resize
   * rather than calling setPixelRatio alone, so the renderer and the camera
   * agree about the new buffer in one step.
   */
  setQualityScale(scale) {
    if (scale === this.qualityScale) return;
    this.qualityScale = scale;
    this.resize(this.width, this.height);
  }

  render() {
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.1);
    this.onUpdate?.(delta, this.timer.getElapsed());
    this.pipeline.render();
  }
}
