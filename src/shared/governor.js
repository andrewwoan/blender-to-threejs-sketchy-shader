/**
 * Give up quality before the device gives up on you.
 *
 * A page does not usually die of one slow frame; it dies of thousands of them.
 * Sustained overrun heats the device, the OS throttles, frames get slower still,
 * and eventually a watchdog kills the tab. Backing off early breaks that loop,
 * and a drawing at 0.6x resolution is a far better outcome than a crash.
 *
 * Two rules make it trustworthy rather than twitchy:
 *
 *  - It reads the MEDIAN of a window of frames, never a single one. Individual
 *    frames spike for reasons that say nothing about sustained load - a garbage
 *    collection, method D's solve landing on that tick, the compositor. A median
 *    ignores all of it and still reacts inside a second.
 *
 *  - It only ever goes DOWN. Recovery sounds desirable and is how you get an
 *    oscillator: step up, immediately exceed budget, step down, repeat, with a
 *    resolution change every second or two - much more distracting than simply
 *    staying at the lower setting. Stepping back up is left as a manual control.
 *
 * Warm-up matters as much as either. Node materials compile on first render and
 * textures upload on first use, so the opening frames are enormous and have
 * nothing to do with steady-state cost. Judging those would drop straight to
 * minimum on a machine that could have run at full.
 */

/**
 * Scales applied to whatever quality.js already chose for the device, so a phone
 * degrades from its own baseline rather than from the desktop one.
 *
 * Pixel ratio is the whole ladder because it is the only lever that is both
 * enormous - cost goes as the SQUARE of it - and free to change at runtime. The
 * others are not: shadow `blurSamples` is a loop bound compiled into the shader,
 * and switching shadows off re-compiles every material in the scene. Doing
 * either at the exact moment a device is already struggling would stall it
 * further, which is precisely the wrong medicine.
 */
const LEVELS = [
  { name: "full", pixelRatio: 1, solveHz: 0 },
  { name: "reduced", pixelRatio: 0.8, solveHz: 20 },
  { name: "low", pixelRatio: 0.62, solveHz: 12 },
  { name: "minimum", pixelRatio: 0.5, solveHz: 8 },
];

export const QUALITY_LEVELS = LEVELS;

/** Frames ignored at startup, while materials compile and textures upload. */
const WARMUP_FRAMES = 90;

/** Frames per decision. ~45 is under a second at any playable rate. */
const SAMPLE_FRAMES = 45;

/**
 * Median frame time that counts as trouble: 28ms, about 36fps.
 *
 * Deliberately above a 60fps budget and below the point it feels broken. React
 * at 16.7ms and every device that is honestly running at 50 gets downgraded for
 * no reason; wait for 33 and you only act once it is already unpleasant.
 */
const BUDGET_MS = 28;

/**
 * @param {(level: number) => void} apply  called once per change, with the index
 *   into LEVELS. Also called immediately for the starting level.
 */
export function createGovernor(apply) {
  let level = 0;
  let warmup = WARMUP_FRAMES;
  const window = [];

  const setLevel = (next) => {
    const clamped = Math.max(0, Math.min(LEVELS.length - 1, next));
    if (clamped === level) return;

    level = clamped;
    apply(level);
    console.info(
      `governor: quality -> ${LEVELS[level].name} (x${LEVELS[level].pixelRatio} pixel ratio)`,
    );
  };

  apply(level);

  return {
    get level() {
      return level;
    },

    /** Manual override, for the GUI. Resets the sampler so it settles first. */
    setLevel(next) {
      const previous = level;
      setLevel(next);
      if (level !== previous) {
        window.length = 0;
        warmup = SAMPLE_FRAMES;
      }
    },

    /** Call once per rendered frame with the wall time since the last one. */
    frame(deltaMs) {
      if (warmup > 0) {
        warmup--;
        return;
      }

      window.push(deltaMs);
      if (window.length < SAMPLE_FRAMES) return;

      window.sort((a, b) => a - b);
      const median = window[window.length >> 1];
      window.length = 0;

      if (median > BUDGET_MS) setLevel(level + 1);
    },
  };
}
