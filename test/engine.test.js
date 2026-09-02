import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame, step, applyAction, observe, poseOf,
  PLAYER_COL, MAX_JUMP, MIN_GAP, LANE_LEN, EMPTY, LOW, HIGH, POSE,
} from "../public/engine.js";

function runLength(lane, from) {
  const kind = lane[from];
  let n = 0;
  while (from + n < lane.length && lane[from + n] === kind) n++;
  return n;
}

test("generator: obstacles are at most 3 wide and always followed by >= 4 gap cells", () => {
  for (let seed = 0; seed < 50; seed++) {
    const g = createGame(seed);
    const cells = [...g.lane];
    for (let i = 0; i < 3000; i++) cells.push(g.nextCell());

    let i = 0;
    while (i < cells.length) {
      if (cells[i] === EMPTY) { i++; continue; }
      const w = runLength(cells, i);
      assert.ok(w >= 1 && w <= MAX_JUMP, `seed ${seed}: width ${w} at ${i}`);
      const gap = cells.slice(i + w, i + w + MIN_GAP);
      if (i + w + MIN_GAP <= cells.length) {
        assert.ok(gap.every((c) => c === 0),
          `seed ${seed}: only ${gap.join("")} after obstacle at ${i}`);
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
  let i = obs.playerIndex + 2;
  while (i < lane.length) {
    if (lane[i] === EMPTY) { i++; continue; }
    const w = runLength(lane, i);
    actions.push({
      atStep: obs.currentStep + (i - obs.playerIndex),
      action: lane[i] === HIGH ? "duck" : "jump",
      width: w,
    });
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
