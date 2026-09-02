// Hand-authored obstacle chunks. A memoryless per-cell coin flip produces
// statistically uniform terrain: every run feels the same and nothing is
// memorable. Sampling from authored sequences gives the lane rhythm and lets
// difficulty introduce shapes rather than just more of the same.
import { LOW, HIGH } from "./cells.js";

// tier gates when a pattern first appears. Each item is one obstacle; the
// generator inserts the required gap after each, so patterns cannot express an
// unclearable spacing by construction.
export const PATTERNS = [
  { name: "low",          tier: 0, items: [[LOW, 1]] },
  { name: "low-mid",      tier: 0, items: [[LOW, 2]] },
  { name: "duck",         tier: 0, items: [[HIGH, 1]] },

  { name: "wide",         tier: 1, items: [[LOW, 3]] },
  { name: "duck-wide",    tier: 1, items: [[HIGH, 2]] },
  { name: "hop-hop",      tier: 1, items: [[LOW, 1], [LOW, 1]] },
  { name: "over-under",   tier: 1, items: [[LOW, 1], [HIGH, 1]] },

  { name: "stairs",       tier: 2, items: [[LOW, 1], [LOW, 2], [LOW, 3]] },
  { name: "under-over",   tier: 2, items: [[HIGH, 2], [LOW, 2]] },
  { name: "weave",        tier: 2, items: [[LOW, 2], [HIGH, 2], [LOW, 2]] },
  { name: "double-duck",  tier: 2, items: [[HIGH, 1], [HIGH, 3]] },

  { name: "gauntlet",     tier: 3, items: [[LOW, 3], [HIGH, 3], [LOW, 3]] },
  { name: "chatter",      tier: 3, items: [[LOW, 1], [HIGH, 1], [LOW, 1], [HIGH, 1]] },
  { name: "wall-run",     tier: 3, items: [[HIGH, 3], [HIGH, 3]] },
];

export const MAX_TIER = Math.max(...PATTERNS.map((p) => p.tier));

// Shapes are introduced on their own schedule rather than following the density
// curve, which does not start moving until the speed ramp has floored - the
// opening minutes would otherwise be nothing but single obstacles.
export const TIER_EVERY = 120;
export const tierFor = (step) =>
  Math.min(MAX_TIER, Math.floor(step / TIER_EVERY));

export function pickPattern(rand, step) {
  const tier = tierFor(step);
  const pool = PATTERNS.filter((p) => p.tier <= tier);
  return pool[Math.floor(rand() * pool.length)];
}
