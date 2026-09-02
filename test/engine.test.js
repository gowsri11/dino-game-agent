import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame, step, applyAction, observe, poseOf,
  PLAYER_COL, MAX_JUMP, MIN_GAP, gapFor, LANE_LEN, EMPTY, LOW, HIGH, POSE,
  difficulty, SPEED_STEPS,
} from "../public/engine.js";

function runLength(lane, from) {
  const kind = lane[from];
  let n = 0;
  while (from + n < lane.length && lane[from + n] === kind) n++;
  return n;
}

test("generator: obstacles are at most 3 wide and leave width+GAP_BASE of gap", () => {
  for (let seed = 0; seed < 50; seed++) {
    const g = createGame(seed);
    const cells = [...g.lane];
    // Sweep the whole difficulty range: the gap floor is squeezed hardest at
    // maximum density, which is exactly where solvability could break.
    for (let i = 0; i < 3000; i++) cells.push(g.nextCell(i));

    let i = 0;
    while (i < cells.length) {
      if (cells[i] === EMPTY) { i++; continue; }
      const w = runLength(cells, i);
      assert.ok(w >= 1 && w <= MAX_JUMP, `seed ${seed}: width ${w} at ${i}`);
      // The gap must cover the recovery a correctly-sized action costs.
      const need = gapFor(w);
      const gap = cells.slice(i + w, i + w + need);
      if (i + w + need <= cells.length) {
        assert.ok(gap.every((c) => c === EMPTY),
          `seed ${seed}: only ${gap.join("")} after width-${w} obstacle at ${i}`);
      }
      i += w;
    }
  }
});

test("no obstacle sits under the player before the game starts", () => {
  for (let seed = 0; seed < 50; seed++) {
    assert.equal(createGame(seed).lane[PLAYER_COL], EMPTY);
  }
});

// Airtime is width+1, so jump(w) clears width w with a cell to spare. That spare
// cell is what makes a mid-cell keypress and a one-step-early liftoff both work.
function clears(width, actWidth, liftEarly, kind = LOW, verb = "jump") {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  const lead = PLAYER_COL + (liftEarly ? 2 : 1);
  for (let k = 0; k < width; k++) g.lane[lead + k] = kind;
  g.nextCell = () => EMPTY;

  applyAction(g, { type: verb, width: actWidth });
  for (let k = 0; k < width + 2; k++) step(g, null);
  return g.alive;
}

test("jump(w) clears width w, whether the press lands on time or a step early", () => {
  for (const w of [1, 2, 3]) {
    assert.ok(clears(w, w, false), `width ${w}: on-time jump(${w}) should clear`);
    assert.ok(clears(w, w, true), `width ${w}: early jump(${w}) should clear`);
  }
});

test("too small a jump still fails", () => {
  // With airtime w+1, one tap (airtime 2) covers widths 1 and 2 but not 3.
  assert.ok(clears(3, 2, false), "two taps clear width 3");
  assert.equal(clears(3, 1, false), false, "one tap must not clear width 3");
});

test("a late action moves the player but does not protect against the cell", () => {
  for (const late of [false, true]) {
    const g = createGame(1);
    g.lane = Array(LANE_LEN).fill(EMPTY);
    g.lane[PLAYER_COL + 1] = LOW;
    g.nextCell = () => EMPTY;

    applyAction(g, { type: "jump", width: 1 });
    g.lateAction = late;               // what main.js sets for a too-late keypress
    step(g, null);

    assert.ok(g.airCells > 0 || !g.alive, "the jump itself must still happen");
    assert.equal(g.alive, !late,
      late ? "a late jump must still clip the obstacle" : "an on-time jump clears it");
  }
});

// --- the two verbs ---------------------------------------------------------

test("low obstacles need a jump, high obstacles need a duck", () => {
  for (const w of [1, 2, 3]) {
    assert.ok(clears(w, w, false, LOW, "jump"), `low w${w}: jump clears`);
    assert.ok(clears(w, w, false, HIGH, "duck"), `high w${w}: duck clears`);
    assert.equal(clears(w, w, false, HIGH, "jump"), false, `high w${w}: jumping hits it`);
    assert.equal(clears(w, w, false, LOW, "duck"), false, `low w${w}: ducking hits it`);
  }
});

test("standing still loses to either kind", () => {
  for (const kind of [LOW, HIGH]) {
    const g = createGame(1);
    g.lane = Array(LANE_LEN).fill(EMPTY);
    g.lane[PLAYER_COL + 1] = kind;
    g.nextCell = () => EMPTY;
    step(g, null);
    assert.equal(g.alive, false, `standing must lose to kind ${kind}`);
  }
});

test("a jump cancels a crouch, but a crouch cannot start in mid-air", () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  g.nextCell = () => EMPTY;

  assert.equal(applyAction(g, { type: "duck", width: 1 }), true);
  assert.equal(poseOf(g), POSE.DUCK);

  assert.equal(applyAction(g, { type: "jump", width: 1 }), true, "jump overrides a duck");
  assert.equal(poseOf(g), POSE.AIR);
  assert.equal(g.duckCells, 0);

  assert.equal(applyAction(g, { type: "duck", width: 1 }), false, "no ducking in mid-air");
  assert.equal(poseOf(g), POSE.AIR);
});

test("space-mashing cannot keep the player airborne forever", () => {
  const g = createGame(7);
  let airborneSteps = 0;
  for (let i = 0; i < 200 && g.alive; i++) {
    applyAction(g, { type: "jump" });   // one press every step
    applyAction(g, { type: "jump" });   // ...and a second, mashing
    if (g.airCells > 0) airborneSteps++;
    step(g, null);
  }
  assert.ok(!g.alive || airborneSteps < 200,
    "mashing space should not grant permanent flight");
  assert.equal(g.alive, false, "a masher should eventually hit an obstacle");
});

// The rule the LLM is told to follow, applied exactly. If this survives, the
// prompt's arithmetic is sound and any agent death is a model error, not ours.
function planFrom(obs) {
  const lane = obs.lane.split("").map(Number);
  const actions = [];
  // Scan from the left so every run is found by its true leading cell, then
  // filter by distance. Starting the scan mid-lane bisects a half-passed
  // obstacle and invents a phantom one behind it.
  let i = 0;
  while (i < lane.length) {
    if (lane[i] === EMPTY) { i++; continue; }
    const w = runLength(lane, i);
    if (i + w >= lane.length) break;   // still arriving; its width is not final yet
    if (i - obs.playerIndex >= 2) {
      actions.push({
        atStep: obs.currentStep + (i - obs.playerIndex),
        action: lane[i] === HIGH ? "duck" : "jump",
        width: w,
      });
    }
    i += w;
  }
  return actions;
}

test("a reference planner using the documented atStep rule survives indefinitely", () => {
  for (let seed = 0; seed < 20; seed++) {
    const g = createGame(seed);
    const scheduled = new Map();

    for (let i = 0; i < 2000 && g.alive; i++) {
      if (i % 5 === 0) {                       // replan on the same cadence as the client
        for (const a of planFrom(observe(g))) {
          if (a.atStep > g.step) scheduled.set(a.atStep, a);
        }
      }
      const dueAt = g.step + 2;                // same early-liftoff rule as main.js
      const due = scheduled.get(dueAt);
      if (due !== undefined) {
        scheduled.delete(dueAt);
        applyAction(g, { type: due.action, width: due.width });
      }
      step(g, null);
    }
    assert.ok(g.alive, `seed ${seed}: perfect planner died at step ${g.step}`);
    assert.equal(g.score, 2000);
  }
});


// --- committing to more than you need is paid for ---------------------------

// Two obstacles spaced exactly as the generator spaces them: the tightest lane a
// correctly-sized action can survive.
function twoObstacles(width, actWidth) {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  const first = PLAYER_COL + 1;
  for (let k = 0; k < width; k++) g.lane[first + k] = LOW;
  const second = first + width + gapFor(width);   // the tightest legal spacing
  g.lane[second] = LOW;
  g.nextCell = () => EMPTY;

  const secondArrivesIn = second - PLAYER_COL;
  applyAction(g, { type: "jump", width: actWidth });
  for (let i = 1; i <= secondArrivesIn && g.alive; i++) {
    // Act for the second obstacle on the last step before it lands. Acting for
    // the first one already happened above; re-acting here would extend it.
    if (i === secondArrivesIn - 1) applyAction(g, { type: "jump", width: 1 });
    step(g, null);
  }
  return g.alive;
}

test("a correctly-sized jump recovers in time for the next obstacle", () => {
  for (const w of [1, 2, 3]) {
    assert.ok(twoObstacles(w, w), `width ${w}: the right-sized jump must survive`);
  }
});

test("an oversized jump is still recovering when the next obstacle lands", () => {
  for (const w of [1, 2]) {
    assert.equal(twoObstacles(w, w + 1), false,
      `width ${w}: jumping one size too big must cost the next obstacle`);
  }
});

test("recovery is charged in proportion to the width committed", () => {
  let last = -1;
  for (const w of [1, 2, 3]) {
    const g = createGame(1);
    g.lane = Array(LANE_LEN).fill(EMPTY);
    g.nextCell = () => EMPTY;
    applyAction(g, { type: "jump", width: w });
    while (g.airCells > 0) step(g, null);
    assert.equal(g.groundCooldown, 2 * w, `width ${w} should owe ${2 * w} cells`);
    assert.ok(g.groundCooldown > last, "wider commitments must cost strictly more");
    last = g.groundCooldown;
  }
});

test("an oversized duck is punished the same way as an oversized jump", () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  g.nextCell = () => EMPTY;
  applyAction(g, { type: "duck", width: 3 });
  while (g.duckCells > 0) step(g, null);
  assert.equal(g.groundCooldown, 6, "duck recovery is charged like jump recovery");
});


// --- the difficulty curve ---------------------------------------------------

test("difficulty keeps climbing after the speed ramp has floored", () => {
  assert.equal(difficulty(0), 0, "no density pressure while speed is still ramping");
  assert.equal(difficulty(SPEED_STEPS), 0, "density starts exactly where speed stops");
  assert.ok(difficulty(SPEED_STEPS + 450) > 0.4, "and rises from there");
  assert.equal(difficulty(1e6), 1, "but is bounded, or lanes stop being clearable");
});

test("obstacles get denser with difficulty but never breach the gap floor", () => {
  const density = (step) => {
    let obstacles = 0, cells = 0;
    for (let seed = 0; seed < 12; seed++) {
      const g = createGame(seed);
      const lane = [];
      for (let i = 0; i < 1500; i++) lane.push(g.nextCell(step));
      for (let i = 0; i < lane.length; i++) {
        if (lane[i] === EMPTY) continue;
        const w = runLength(lane, i);
        obstacles++;
        const gap = lane.slice(i + w, i + w + gapFor(w));
        if (i + w + gapFor(w) <= lane.length) {
          assert.ok(gap.every((c) => c === EMPTY),
            `step ${step}: width-${w} obstacle at ${i} left only ${gap.join("")}`);
        }
        i += w - 1;
      }
      cells += lane.length;
    }
    return obstacles / cells;
  };

  const easy = density(0);
  const hard = density(SPEED_STEPS + 900);
  assert.ok(hard > easy * 1.2,
    `late game should be denser: ${easy.toFixed(4)} -> ${hard.toFixed(4)}`);
});
