import * as THREE from "three/webgpu";
import { QUALITY } from "../shared/quality.js";

/**
 * The crosshatch tone sheet, generated at runtime so this repo ships no binary
 * assets.
 *
 * Both methods here read the same contract from it, and it is the single most
 * important thing to get right if you swap in your own sheet:
 *
 *   R = the LIGHTEST tone (sparse strokes, high mean)
 *   G = the middle tone
 *   B = the DARKEST tone (dense strokes, low mean)
 *
 * The three channels are independent stroke densities, not a colour. That has
 * two consequences worth stating out loud, because both are easy to trip over:
 *
 *  - The texture must be sampled with `NoColorSpace`. Run it through an sRGB
 *    decode and the tone ramp bends.
 *  - It must never be compressed with a format that shares chroma between
 *    channels — no lossy WebP/JPEG, no ETC1S. Those all assume the channels are
 *    a colour and will happily darken one while brightening another. Lossless
 *    PNG/WebP, or three single-channel textures, are the safe options.
 *
 * The generator draws short pencil-ish strokes with wrap-around so the sheet
 * tiles seamlessly, then packs the three passes into one RGB texture.
 */

// Half size and half the strokes on a phone - see quality.js. Widths compensate
// so the three channels keep their mean tones, which THIS method depends on more
// than C does: the permute reads as a redraw only while all three match.
const SIZE = QUALITY.sheetSize;
const PX = SIZE / 1024;
const WIDTH = PX / QUALITY.sheetDensity;

// Per-channel recipe. `strokes` is what actually drives the tone; the angles are
// the hatch directions layered on top of each other (one for the light tone, two
// crossing for the middle, three for the dark).
// Counts are chosen so the three channels land near mean tones of roughly
// 0.85 / 0.67 / 0.33. Under alpha compositing the mean of a channel is about
// exp(-coverage * alpha), so tone falls off exponentially with stroke count —
// which is why the dark channel needs three times the strokes of the light one
// for what looks like a linear step in density.
const CHANNELS = [
  { strokes: 3200, angles: [-42], width: [1.1, 2.0], alpha: [0.18, 0.36] },
  { strokes: 6000, angles: [-42, 44], width: [1.2, 2.3], alpha: [0.22, 0.44] },
  { strokes: 11000, angles: [-42, 44, 90], width: [1.4, 2.8], alpha: [0.28, 0.54] },
];

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Deterministic PRNG (mulberry32). A fixed seed means everyone who clones this
 * repo is looking at the same sheet, which matters when the whole point is
 * comparing two looks against each other.
 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One tone layer, as a grayscale canvas: white paper, dark strokes.
 *
 * Each stroke is drawn nine times — at the origin and shifted by ±SIZE on both
 * axes — so anything crossing an edge reappears on the opposite one and the
 * sheet tiles. Cheap, and much simpler than clipping the strokes.
 */
function drawToneLayer(spec, random) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.lineCap = "round";
  ctx.strokeStyle = "#000000";

  const perAngle = Math.round(
    (spec.strokes * QUALITY.sheetDensity) / spec.angles.length,
  );

  for (const baseAngle of spec.angles) {
    for (let i = 0; i < perAngle; i++) {
      const x = random() * SIZE;
      const y = random() * SIZE;

      // A few degrees of wander per stroke: a perfectly parallel set reads as a
      // printed screen, not as a hand holding a pencil.
      const angle = ((baseAngle + (random() - 0.5) * 9) * Math.PI) / 180;
      const length = lerp(SIZE * 0.05, SIZE * 0.19, random());

      // Bow the stroke slightly. Drawn as a quadratic through a control point
      // pushed off the midpoint's perpendicular.
      const dx = Math.cos(angle) * length;
      const dy = Math.sin(angle) * length;
      const bow = (random() - 0.5) * length * 0.09;
      const cx = dx * 0.5 - Math.sin(angle) * bow;
      const cy = dy * 0.5 + Math.cos(angle) * bow;

      ctx.lineWidth = Math.max(
        0.6,
        lerp(spec.width[0], spec.width[1], random()) * WIDTH,
      );
      ctx.globalAlpha = lerp(spec.alpha[0], spec.alpha[1], random());

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const sx = x + ox * SIZE;
          const sy = y + oy * SIZE;

          // Skip the copies that cannot possibly touch the canvas.
          if (sx + Math.min(0, dx) > SIZE || sx + Math.max(0, dx) < 0) continue;
          if (sy + Math.min(0, dy) > SIZE || sy + Math.max(0, dy) < 0) continue;

          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(sx + cx, sy + cy, sx + dx, sy + dy);
          ctx.stroke();
        }
      }
    }
  }

  ctx.globalAlpha = 1;
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // Free the backing store immediately - see the note in markSheets.js.
  canvas.width = canvas.height = 0;

  return data;
}

let cached = null;

/** The shared tone sheet. Built once, handed to every material that wants it. */
export function getCrosshatchTexture() {
  if (cached) return cached;

  const random = makeRandom(0x5eed1234);
  const layers = CHANNELS.map((spec) => drawToneLayer(spec, random));

  // Pack the three grayscale passes into the R/G/B of one RGBA buffer.
  const packed = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    packed[i * 4 + 0] = layers[0][i * 4];
    packed[i * 4 + 1] = layers[1][i * 4];
    packed[i * 4 + 2] = layers[2][i * 4];
    packed[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(packed, SIZE, SIZE, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Stroke densities, not a colour — see the note at the top of this file.
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  cached = texture;
  return cached;
}
