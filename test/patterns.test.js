import test from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, MAX_TIER, TIER_EVERY, tierFor, pickPattern } from "../public/patterns.js";
import { createGame, gapFor, EMPTY, LOW, HIGH } from "../public/engine.js";

test("every pattern is well formed and uses only legal widths", () => {
  const names = new Set();
  for (const p of PATTERNS) {
    assert.ok(p.name && !names.has(p.name), `duplicate or missing name: ${p.name}`);
    names.add(p.name);
    assert.ok(Number.isInteger(p.tier) && p.tier >= 0, `${p.name}: bad tier`);
    assert.ok(p.items.length > 0, `${p.name}: empty`);
    for (const [kind, width] of p.items) {
      assert.ok(kind === LOW || kind === HIGH, `${p.name}: bad kind ${kind}`);
      assert.ok(width >= 1 && width <= 3, `${p.name}: bad width ${width}`);
    }
  }
});

test("tier 0 is reachable immediately and every tier eventually unlocks", () => {
  assert.ok(PATTERNS.some((p) => p.tier === 0), "something must be available at step 0");
  assert.equal(tierFor(0), 0);
  assert.equal(tierFor(TIER_EVERY), 1);
  assert.equal(tierFor(TIER_EVERY * MAX_TIER), MAX_TIER);
  assert.equal(tierFor(1e6), MAX_TIER, "tiers are capped, not unbounded");
});

test("pickPattern never returns a pattern above the current tier", () => {
  let rand = 0;
  const seq = () => ((rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const step of [0, TIER_EVERY, TIER_EVERY * 2, TIER_EVERY * 9]) {
    for (let i = 0; i < 400; i++) {
      const p = pickPattern(seq, step);
      assert.ok(p, `step ${step}: pickPattern returned nothing`);
      assert.ok(p.tier <= tierFor(step), `step ${step}: got tier ${p.tier}`);
    }
  }
});

test("later tiers introduce shapes the opening never produces", () => {
  const seen = (step) => {
    const names = new Set();
    let rand = step + 1;
    const seq = () => ((rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 800; i++) names.add(pickPattern(seq, step).name);
    return names;
  };
  const early = seen(0);
  const late = seen(TIER_EVERY * MAX_TIER);
  assert.ok(late.size > early.size, "the late game should draw from a wider pool");
  for (const n of early) assert.ok(late.has(n), `${n} should still appear later`);
});

// The invariant that matters: whatever the patterns say, the generator must
// still leave room for a correctly-sized action to recover.
test("pattern-generated lanes keep the gap floor at every difficulty", () => {
  for (let seed = 0; seed < 30; seed++) {
    const g = createGame(seed);
    const cells = [...g.lane];
    for (let i = 0; i < 2500; i++) cells.push(g.nextCell(i));

    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === EMPTY) continue;
      const kind = cells[i];
      let w = 0;
      while (i + w < cells.length && cells[i + w] === kind) w++;
      assert.ok(w <= 3, `seed ${seed}: width ${w} at ${i}`);
      const need = gapFor(w);
      if (i + w + need <= cells.length) {
        const gap = cells.slice(i + w, i + w + need);
        assert.ok(gap.every((c) => c === EMPTY),
          `seed ${seed}: width-${w} at ${i} left only ${gap.join("")}`);
      }
      i += w - 1;
    }
  }
});
