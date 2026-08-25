import * as THREE from "three/webgpu";

/**
 * The six mark styles method C switches between, generated at runtime.
 *
 * These are TONAL ART MAPS, not ordinary textures, and the difference is the
 * whole reason this file exists rather than just reusing crosshatch.js.
 *
 * A tone sheet (crosshatch.js) holds three FIXED densities and the shader
 * crossfades between them. That works, but it can only ever give you the three
 * drawings that were baked. A tonal art map instead encodes a stroke's RANK in
 * its grey level: the first stroke drawn is black, the last is near-white, and
 * everything in between is a ramp. The shader then just thresholds:
 *
 *     show every stroke whose rank is darker than the current tone
 *
 * Raise the threshold and strokes APPEAR, one at a time, in the order they were
 * drawn - between the strokes already there, never on top of them. That is what
 * an artist does when an area needs to go darker, and it gives a continuous tone
 * response out of a single greyscale channel.
 *
 * The mechanism is `globalCompositeOperation = "darken"`: each pixel keeps the
 * MINIMUM of what has been drawn there, so a later (lighter) stroke can never
 * erase an earlier (darker) one. Without it the last stroke drawn would win and
 * the rank ordering would be destroyed.
 *
 * Six styles packed into two RGB textures, three channels each - the same
 * channel-packing idiom as crosshatch.js, for the same reason: the shader
 * samples all of them every fragment to allow live style switching, and two
 * fetches is a great deal cheaper than six.
 */

const SIZE = 1024;

/** Index order the shader uses. Do not reorder without updating the material. */
export const MARK_STYLES = [
  "crosshatch", // 0  sheetA.r
  "hatch", //     1  sheetA.g
  "lines", //     2  sheetA.b
  "scribbles", // 3  sheetB.r
  "stipples", //  4  sheetB.g
  "chaotic", //   5  sheetB.b
];

const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic PRNG (mulberry32), so every clone gets identical sheets. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newSheet() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // See the header: min-blend is what preserves stroke rank.
  ctx.globalCompositeOperation = "darken";
  return { canvas, ctx };
}

/**
 * Run `draw` nine times - at the origin and shifted by +/-SIZE on both axes - so
 * a mark crossing an edge reappears on the opposite one and the sheet tiles.
 * `reach` is a generous bound on how far the mark extends from (x, y), used only
 * to skip copies that cannot touch the canvas.
 */
function tiled(x, y, reach, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const sx = x + ox * SIZE;
      const sy = y + oy * SIZE;
      if (sx + reach < 0 || sx - reach > SIZE) continue;
      if (sy + reach < 0 || sy - reach > SIZE) continue;
      draw(sx, sy);
    }
  }
}

/** Grey level for a stroke's position in the draw order. 0 = first = darkest. */
function rankStyle(i, count) {
  // Gamma < 1 spends more of the ramp on the early strokes, which is where the
  // eye actually reads tone - a linear ramp leaves the light end almost empty.
  const level = Math.round(255 * Math.pow(i / count, 0.75));
  return `rgb(${level},${level},${level})`;
}

/** Straight-ish bowed strokes at one or more fixed angles. */
function drawStrokes(ctx, random, { count, angles, length, width, wander, bow }) {
  for (let i = 0; i < count; i++) {
    ctx.strokeStyle = rankStyle(i, count);

    const base = angles[Math.floor(random() * angles.length)];
    const angle = ((base + (random() - 0.5) * wander) * Math.PI) / 180;
    const len = lerp(length[0], length[1], random()) * SIZE;
    ctx.lineWidth = lerp(width[0], width[1], random());

    const dx = Math.cos(angle) * len;
    const dy = Math.sin(angle) * len;
    const b = (random() - 0.5) * len * bow;
    const cx = dx * 0.5 - Math.sin(angle) * b;
    const cy = dy * 0.5 + Math.cos(angle) * b;

    const x = random() * SIZE;
    const y = random() * SIZE;

    tiled(x, y, len + 4, (sx, sy) => {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx + cx, sy + cy, sx + dx, sy + dy);
      ctx.stroke();
    });
  }
}

/** Loose multi-segment squiggles that double back on themselves. */
function drawScribbles(ctx, random, { count, segments, step, width }) {
  for (let i = 0; i < count; i++) {
    ctx.strokeStyle = rankStyle(i, count);
    ctx.lineWidth = lerp(width[0], width[1], random());

    const n = Math.round(lerp(segments[0], segments[1], random()));
    const stride = lerp(step[0], step[1], random()) * SIZE;

    // Build the path once in local coordinates, then stamp it nine times.
    const pts = [[0, 0]];
    let heading = random() * Math.PI * 2;
    for (let s = 0; s < n; s++) {
      // A big turn per segment is what separates a scribble from a wobbly line.
      heading += (random() - 0.5) * 2.6;
      const [px, py] = pts[pts.length - 1];
      pts.push([px + Math.cos(heading) * stride, py + Math.sin(heading) * stride]);
    }

    const reach = stride * n + 4;
    const x = random() * SIZE;
    const y = random() * SIZE;

    tiled(x, y, reach, (sx, sy) => {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      for (let p = 1; p < pts.length; p++) {
        ctx.lineTo(sx + pts[p][0], sy + pts[p][1]);
      }
      ctx.stroke();
    });
  }
}

/** Dots. Tone comes from how many have appeared, not how dark each one is. */
function drawStipples(ctx, random, { count, radius }) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rankStyle(i, count);

    const r = lerp(radius[0], radius[1], random());
    const x = random() * SIZE;
    const y = random() * SIZE;

    tiled(x, y, r + 2, (sx, sy) => {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

/** One greyscale layer per style, as a Uint8 buffer of the red channel. */
function buildLayer(style) {
  const { canvas, ctx } = newSheet();
  const random = makeRandom(0xc0ffee ^ (style.length * 2654435761));

  switch (style) {
    case "crosshatch":
      drawStrokes(ctx, random, {
        count: 9000,
        angles: [-42, 44],
        length: [0.05, 0.19],
        width: [1.2, 2.4],
        wander: 9,
        bow: 0.09,
      });
      break;

    case "hatch":
      drawStrokes(ctx, random, {
        count: 7000,
        angles: [-42],
        length: [0.06, 0.22],
        width: [1.1, 2.2],
        wander: 7,
        bow: 0.07,
      });
      break;

    case "lines":
      // Long, near-horizontal, barely bowed: ruled lines rather than hatching.
      drawStrokes(ctx, random, {
        count: 3000,
        angles: [0],
        length: [0.35, 0.9],
        width: [1.0, 2.0],
        wander: 3,
        bow: 0.02,
      });
      break;

    case "scribbles":
      drawScribbles(ctx, random, {
        count: 3600,
        segments: [4, 9],
        step: [0.012, 0.032],
        width: [1.1, 2.3],
      });
      break;

    case "stipples":
      drawStipples(ctx, random, { count: 52000, radius: [0.8, 2.7] });
      break;

    case "chaotic":
      // Every direction, short and heavily bowed - the "angry sketch" pass.
      drawStrokes(ctx, random, {
        count: 11000,
        angles: [0, 30, 60, 90, 120, 150],
        length: [0.03, 0.13],
        width: [1.2, 2.6],
        wander: 40,
        bow: 0.35,
      });
      break;

    default:
      throw new Error(`unknown mark style: ${style}`);
  }

  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

/** Pack three greyscale layers into the R/G/B of one RGBA DataTexture. */
function packSheet(layers) {
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
  // Stroke ranks, not a colour. An sRGB decode would bend the threshold ramp and
  // the tone response with it - same contract as crosshatch.js.
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

let cached = null;

/** The two packed sheets, built once and shared by every material that asks. */
export function getMarkSheets() {
  if (cached) return cached;

  cached = {
    a: packSheet(MARK_STYLES.slice(0, 3).map(buildLayer)),
    b: packSheet(MARK_STYLES.slice(3, 6).map(buildLayer)),
  };
  return cached;
}
