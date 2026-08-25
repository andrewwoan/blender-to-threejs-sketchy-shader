import * as THREE from "three/webgpu";
import { QUALITY } from "../shared/quality.js";

/**
 * Paper stock, generated at runtime. Both methods multiply the finished frame
 * by this, which is what stops the render reading as "3D with a filter" and
 * starts it reading as ink sitting on a sheet.
 *
 * It is deliberately low contrast. Paper is a subtle multiply — anything strong
 * enough to notice on its own is too strong.
 */

const SIZE = 512;

function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cached = null;

export function getPaperTexture() {
  if (cached) return cached;

  const random = makeRandom(0x9a17c3);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f6f3ec";
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Fibres: faint short strokes in every direction, a few shades either side of
  // the base tone, so the grain has structure rather than just being per-pixel
  // noise (which mostly disappears once it is minified).
  ctx.lineCap = "round";
  for (let i = 0; i < QUALITY.paperStrokes; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    const angle = random() * Math.PI * 2;
    const length = 1 + random() * 5;
    const dark = random() < 0.5;

    ctx.strokeStyle = dark ? "#000000" : "#ffffff";
    ctx.globalAlpha = 0.012 + random() * 0.03;
    ctx.lineWidth = 0.6 + random() * 1.1;

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  // A handful of broad soft blotches — the unevenness of a real sheet's
  // absorption. Large and very faint, so they read as tone, not as marks.
  for (let i = 0; i < 40; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    const r = SIZE * (0.06 + random() * 0.22);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = random() < 0.5 ? "0, 0, 0" : "255, 255, 255";

    gradient.addColorStop(0, `rgba(${tone}, ${0.02 + random() * 0.03})`);
    gradient.addColorStop(1, `rgba(${tone}, 0)`);

    ctx.globalAlpha = 1;
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;

  cached = texture;
  return cached;
}
