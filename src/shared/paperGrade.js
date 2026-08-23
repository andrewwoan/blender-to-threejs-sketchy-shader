import * as THREE from "three/webgpu";
import {
  screenUV,
  texture,
  uniform,
  color,
  vec2,
  vec3,
  float,
  mix,
  dot,
  smoothstep,
} from "three/tsl";
import { getPaperTexture } from "../textures/paper.js";

/**
 * The grade both methods share: multiply the frame by paper, push contrast,
 * then vignette.
 *
 * It lives here rather than inside either method so the split screen is an
 * honest comparison — the only thing that differs between the two panes is the
 * hatching and the outline, not the finishing.
 */
export function createPaperGrade() {
  const uPaperTint = uniform(color(0xf0f7ff)); // cool paper white
  const uTintAmount = uniform(0.3);
  const uContrast = uniform(1.2);
  const uBWAmount = uniform(0.0);

  const uVignetteAmount = uniform(1.0);
  const uVignetteStrength = uniform(0.85);
  const uVignetteRadius = uniform(0.68);
  const uVignetteSoftness = uniform(0.32);
  // Exponent of the superellipse the falloff is measured against: 2 is a plain
  // oval, higher squares it off into a rounded rectangle.
  const uVignetteRoundness = uniform(6.0);

  const uScreenAspect = uniform(1);
  const uImageAspect = uniform(1);

  const paperTexture = getPaperTexture();
  if (paperTexture.image) {
    uImageAspect.value = paperTexture.image.width / paperTexture.image.height;
  }

  // Cover-fit the paper to the viewport so the grain never stretches with the
  // window. Same maths as `background-size: cover`.
  const ratio = uScreenAspect.div(uImageAspect);
  const scale = vec2(
    ratio.greaterThan(float(1)).select(float(1), ratio),
    ratio.greaterThan(float(1)).select(ratio.reciprocal(), float(1)),
  );
  const centeredUV = screenUV.sub(0.5).mul(scale).add(0.5);
  const rawPaper = texture(paperTexture, centeredUV);

  const tintedPaper = mix(rawPaper, rawPaper.mul(uPaperTint), uTintAmount);

  /** Paper multiply + optional desaturate + contrast. */
  const grade = (sceneColor) => {
    const composited = sceneColor.mul(tintedPaper);

    const luminance = dot(composited.rgb, vec3(0.2126, 0.7152, 0.0722));
    const grayscale = vec3(luminance, luminance, luminance);
    const maybeBW = mix(composited.rgb, grayscale, uBWAmount);

    return maybeBW.sub(0.5).mul(uContrast).add(0.5);
  };

  /**
   * Vignette, applied LAST — over the ink, not under it.
   *
   * Fold it into `grade` instead and anything composited after the grade (the
   * outline, in method B) sits on top of the darkened border at full strength,
   * which immediately gives away that the ink is a separate layer.
   */
  const vignette = (colorNode) => {
    // |x|^n + |y|^n, rooted back to a length. At n = 2 this is exactly
    // length(); raising n pulls the iso-lines out toward the frame corners.
    const edge = screenUV.sub(0.5).abs();
    const n = uVignetteRoundness;
    const dist = edge.x.pow(n).add(edge.y.pow(n)).pow(float(1).div(n));

    const falloff = smoothstep(
      uVignetteRadius.sub(uVignetteSoftness),
      uVignetteRadius,
      dist,
    ).mul(uVignetteStrength);

    return colorNode.mul(
      float(1).sub(falloff.mul(uVignetteAmount)).clamp(0, 1),
    );
  };

  return {
    grade,
    vignette,
    tintedPaper,
    setAspect: (width, height) => {
      uScreenAspect.value = width / height;
    },
    uniforms: {
      uPaperTint,
      uTintAmount,
      uContrast,
      uBWAmount,
      uVignetteAmount,
      uVignetteStrength,
      uVignetteRadius,
      uVignetteSoftness,
      uVignetteRoundness,
    },
  };
}
