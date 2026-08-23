# Hatch & Outline Lab

![The two portfolio sites these techniques were extracted from: Katsumi Watanabe's on the left, Allen Zhang's on the right](Sketchy.webp)

> Extracted from two demo sites using these techniques — **method A** from
> [Katsumi Watanabe's Portfolio](https://katsumi-watanabe-folio.vercel.app/) (left
> above), **method B** from
> [Allen Zhang's Portfolio](https://allen-zhang-folio.vercel.app/) (right).

Two ways to make a three.js scene look hand-drawn — crosshatched shading, ink
outlines, and a stop-motion "boil" — running side by side on the same objects,
the same lights, and the same paper grade, so the only thing that differs is the
technique.

Everything is [three.js](https://threejs.org) **WebGPU + TSL**, and the app loads
no binary assets at all: the crosshatch sheet and the paper are generated on a
canvas at startup.

```bash
npm install
npm run dev
```

Needs a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+, Safari 26+).

Drag either half to orbit and scroll to zoom — the two cameras are locked
together, so whichever pane you grab, both move. Orbiting is the fastest way to
see where the two methods actually diverge: watch method A's outline hold rock
steady while method B's swims a little, and watch B keep drawing the torus knot's
interior contours from angles where A shows only its silhouette.

---

## The two methods

|                       | **A — Inverted Hull**                              | **B — Screen-Space Line Art**                                     |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| **Hatching**          | Sheet multiplied in through a shadow mask          | Sheet read as four tone stops: white → R → G → B                  |
| **Hatch boil**        | Cycle which channel is sampled (R → G → B)         | Walk the sampling UV one golden angle per step                    |
| **Outline**           | Backface-expanded duplicate geometry               | Post-process edge detection over a depth/normal/id pre-pass       |
| **Outline boil**      | Per-vertex hash jitter on a stepped clock          | Screen-space wobble + jerk + running-dry noise on a stepped clock |
| **Interior contours** | No — a hull is only ever a silhouette              | Yes                                                               |
| **Line width**        | Object-space, so it varies with distance and scale | Uniform in pixels, everywhere                                     |
| **Cost**              | +1 draw call per mesh, no post-processing          | +1 full scene pass, 3 buffers                                     |
| **Steadiness**        | World-space — rock steady under camera motion      | Screen-space — swims slightly as the camera moves                 |

Neither is "the right one". A has almost no infrastructure and composites with
anything; B inks a whole scene with no per-mesh setup and can modulate the line
per pixel. Look at the torus knot in both panes: A draws only its outside, B
draws where the tube passes in front of itself.

### The one idea both boils share

```js
const step = time.mul(speed).floor();
```

The clock runs continuously; `floor()` makes the drawing change only on integer
ticks and **hold** in between. That hold is what separates a hand-drawn boil from
a smooth animated wobble, and every noise in this repo is seeded on it.

### Drawn cast shadows

Both methods shade a surface by its own angle to the light. That is why a flat
floor never hatches — its normal does not change just because something is
standing on it — and it is why cast shadows in most stylised renderers come out
as a **flat grey patch laid over the drawing**. The shadow arrives separately, as
a light attenuation the renderer multiplies in *after* `colorNode`, so by default
it can only dim what is already there.

An illustrator does not do that. A cast shadow is *drawn*, with the same strokes
as everything else. `material.receivedShadowNode` is the hook that lets you say
so — it hands you the shadow term (`0` = shadowed, `1` = lit) and takes a
replacement:

```js
material.receivedShadowNode = Fn(([shadow]) => mix(inShadow, float(1), shadow));
```

Return the hatch sheet instead of a constant and the strokes *become* the shadow:
dark on a stroke, paper between them. Because it reuses the same nodes the
surface samples, it boils in lockstep and lands on the receiving surface's own
UVs, which is where a drawn shadow's strokes belong.

Each method does it in its own idiom — A returns its boiled greyscale sheet, B
returns the ramp's densest stops — and both expose a **`cast shadow: drawn`**
slider. Drag it 0 → 1 to watch a flat patch turn into hatching.

One thing to know if you copy this: the sheet averages well above zero, so
substituting it straight in makes the shadow much *lighter* than the flat one it
replaced and the objects stop sitting on the ground. Both methods pull it back
down with a `cast shadow: depth` control, tuned so flipping `drawn` between 0 and
1 keeps roughly the same weight. In method B that multiply is unavoidable rather
than a fudge: shadow is "further along the tone ramp", but the ramp runs out at
B — there is no stop denser than the densest one.

> Neither source project does this. It is the one place this repo goes past what
> it was extracted from.

---

## Layout

```
src/
  main.js                          two panes, one rAF
  shared/
    Pane.js                        canvas + renderer + camera + loop
    linkedOrbit.js                 one OrbitControls per pane, mirrored to each other
    dummyScene.js                  the cube / knot / sphere / ground, and the lights
    paperGrade.js                  paper multiply, contrast, vignette (shared by both)
  textures/
    crosshatch.js                  procedural 3-channel tone sheet
    paper.js                       procedural paper stock
  methods/
    invertedHull/                  METHOD A
      hatchedMaterial.js             shadow-masked multiply + channel-permute boil
      outline.js                     the hull, normal smoothing, vertex jitter
      index.js                       wiring + GUI
    screenSpace/                   METHOD B
      hatchedMaterial.js             four tone stops + golden-angle boil
      outlinePipeline.js             MRT pre-pass + edge detection + hand noise
      index.js                       wiring + GUI
```

Each method folder is self-contained — copy one out and it works on its own.

---

## The crosshatch sheet

Both methods read the same contract from the texture, and it is the thing to get
right if you swap in your own:

- **R = lightest** (sparse strokes), **G = middle**, **B = darkest** (dense).
- Sample it with `NoColorSpace`. It is three independent stroke densities, not a
  colour; an sRGB decode bends the tone ramp.
- **Never** compress it with a format that shares chroma across channels — no
  lossy WebP/JPEG, no ETC1S. They all assume the channels are a colour and will
  darken one while brightening another. Lossless PNG/WebP, or three
  single-channel textures, are the safe options.

`src/textures/crosshatch.js` generates one at startup (~20k canvas strokes, well
under a second) with wrap-around drawing so it tiles seamlessly, and a fixed PRNG
seed so everyone sees the same sheet.

Method A additionally normalises the three channels against each other
(`channelBalance*` / `channelContrast*`). Those numbers are a property of the
sheet, not of the technique: if all three channels do not read at the same
average tone, the channel permute becomes a brightness **flicker** instead of a
redraw. Retune them whenever you change the texture.

---

## Gotchas worth knowing

**Inverted hulls need smoothed normals.** A cube out of any DCC has 24 vertices,
not 8 — each corner exists once per face, with that face's normal. Inflate along
those and the copies fly apart, splitting the hull open at every edge. Average
the normals of co-located vertices first, on a clone, so the visible mesh keeps
its hard shading. `Outline.smoothNormals` does this.

**`.sample()` returns a vec4, and `dot()` on a vec4 includes alpha.** In the edge
pass, `colorToDirection(normalTex.sample(uv))` compares four components, and
alpha is 1 across every pixel the pre-pass drew — so `1 - dot` collapses to
`-cos(angle)`: negative everywhere, largest on flat surfaces, and it _subtracts_
from the other edge terms. The symptom is a crease slider that appears to do
nothing, or that erases silhouettes when you turn it up. Take `.rgb` and
normalize.

**Depth alone cannot separate two surfaces in nearly the same plane.** A cutout
against the wall behind it, a box sitting flat on the floor — the depth gap is
too small to threshold. The object-id channel (a hash of `modelPosition`) is what
draws those. Note the scale-and-bias before hashing: TSL's `hash()` starts with
`toUint()`, which _truncates_, so raw metres would collapse a small scene onto one
id and negative seeds are undefined.

**Mirror the camera by position + target, not by rotation.** OrbitControls
rebuilds its spherical state from `position - target` at the top of every
`update()` and ends with `lookAt(target)`, so those two vectors are the whole
state — copy them and it works the orientation out itself. Copying the quaternion
as well just adds a second source of truth to drift. `linkedOrbit.js` also needs
a re-entrancy latch, since writing to a mirror makes it emit `change` and write
straight back.

**Ink that fades should also thin.** In method B one noise field drives both the
opacity and the sampling distance, so faint segments of the line are narrow too.
Varying only the opacity reads as a dissolve, not as a pen running dry.

**The hatch density follows the UV unwrap.** Both methods sample through the
mesh's own UVs, so a 1-unit cube and a 40-unit ground plane unwrapped to the same
0..1 get wildly different stroke sizes. There is no shader setting for it — fix
it in the geometry or in Blender. `dummyScene.js` scales the ground's UVs for
exactly this reason.

---

## Extras in the code but off by default

**Ink-bleed reveal** (method A, `fluidReveal`). Colour floods into a grayscale
surface around a moving point in object-local space, behind an edge that is
displaced by noise stepped on the boil clock — so the patch _jitters_ like
boiling ink rather than flowing like a liquid. Toggle it in the GUI under
"A — Ink-bleed reveal (sphere)".

**Debug views** (method B). The outline folder can render the raw edge mask, the
view-normal buffer, or the object-id buffer instead of the composite. Which stage
comes out empty tells you where a missing line went.

---

## Credits

### Where this came from

Both techniques were built for, and are in production on, two portfolio sites:

|                         | Site                                                                       | Method it runs                |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| Left in the screenshot  | [Katsumi Watanabe's Portfolio](https://katsumi-watanabe-folio.vercel.app/) | **A** — inverted hull         |
| Right in the screenshot | [Allen Zhang's Portfolio](https://allen-zhang-folio.vercel.app/)           | **B** — screen-space line art |

### Assets in this repo

The app loads none. The crosshatch sheet and the paper stock are both generated
at runtime by `src/textures/` — see [The crosshatch sheet](#the-crosshatch-sheet).
There is no third-party image, model, font, or audio file in the build to
attribute, and nothing to license around.

`public/favicon.svg` is hand-written SVG — a hatch swatch with the same
light-to-dark density ramp the materials read out of the sheet — so it carries no
attribution either. It is covered by this repo's MIT license along with the code.

The only binary in the repo is `Sketchy.webp` above, which is a screenshot of the
two sites and is never loaded by the demo.

### Dependencies

Licenses are the `license` field each package declares at the version installed
here.

- [three.js](https://threejs.org) 0.183.2 — MIT
- [lil-gui](https://lil-gui.georgealways.com) 0.21.0 — MIT
- [Vite](https://vite.dev) 8 — MIT

### Attributions carried over from the source projects

None of the assets below ship in this repo — they belong to the two sites above.
They are reproduced here so the attribution travels with the code it was
extracted alongside.

#### Katsumi Watanabe's Portfolio — music

Music by [AtlasAudio](https://pixabay.com/users/atlasaudio-54514918/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=512255)
from [Pixabay](https://pixabay.com/music//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=512255).

#### Katsumi Watanabe's Portfolio — thunder

Three one-shots, played at random per lightning strike in Scene 1. All were
trimmed to start on their transient, faded out, peak-matched to -1dBFS, and
encoded to Ogg Vorbis and MP3 for the web.

**`thunder-crack`** — near strike

> "Thunder, Very Close, Rain, 01.wav" by InspectorJ (www.jshaw.co.uk)

- **Author:** InspectorJ
- **Source:** [Thunder, Very Close, Rain, 01 — OpenGameArt.org](https://opengameart.org/content/thunder-very-close-rain-01)
- **License:** [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/) — attribution required
- **Changes:** cut from 1.05s (the original opens with about a second of
  rain-only lead-in) to 9.5s long, 2.5s fade-out, +1.0dB. Original is a
  12.8-second 16-bit/44.1kHz stereo WAV.

**`thunder-roll`** — mid-distance strike

- **Author:** WuxiaScrub
- **Source:** [Rain + Long Thunder — OpenGameArt.org](https://opengameart.org/content/rain-long-thunder)
- **License:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain, no attribution required (credited anyway)
- **Changes:** cut from 21.0s (where the thunder begins in the 44-second
  original) to 13s long, 3s fade-out, +1.5dB.

**`thunder-distant`** — far strike

- **Author:** WuxiaScrub
- **Source:** [Rain + Long Thunder — OpenGameArt.org](https://opengameart.org/content/rain-long-thunder)
- **License:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain, no attribution required (credited anyway)
- **Changes:** cut from 29.5s — partway into the same roll, so it has no sharp
  transient and reads as distant — to 9s long, 2.5s fade-out, +6.8dB.

#### Allen Zhang's Portfolio — tree image

Tree cutout used in the scenery.

> Isolated Tree PNG by Vecteezy

- **Asset:** [Isolated Tree PNG](https://www.vecteezy.com/png/13666709-isolated-tree-png)
- **Source:** [Vecteezy](https://www.vecteezy.com)
- **License:** [Vecteezy Free License](https://www.vecteezy.com/licensing-agreement) — attribution required

#### Libraries used by the source projects

Beyond the three above, those sites also use:

- [howler.js](https://howlerjs.com) 2.2.4 — MIT
- [GSAP](https://gsap.com) 3.15.0 — [standard "no charge" license](https://gsap.com/standard-license)
- [normalize-wheel](https://github.com/basilfx/normalize-wheel) 1.0.1 — BSD-3-Clause
- [events](https://github.com/browserify/events) 3.3.0 — MIT

---

## License

MIT, for the code in this repository.
