// Pure game logic. No DOM, no timers, no rendering.
// Runs unchanged in the browser and in Node (tests, headless agent runs).

import { EMPTY, LOW, HIGH, POSE } from "./cells.js";
import { pickPattern } from "./patterns.js";
export { EMPTY, LOW, HIGH, POSE } from "./cells.js";

export const LANE_WIDTH = 24;        // visible cells
export const LANE_LEN = LANE_WIDTH + 1; // one extra so cells slide in smoothly
export const PLAYER_COL = 2;
export const MAX_JUMP = 3;
// Airtime is width + 1. The spare cell absorbs the fact that a press lands at an
// arbitrary point inside a cell, and lets liftoff happen a step before contact.
export const MAX_AIR = MAX_JUMP + 1;
// Recovery after an action costs as many cells as the width committed to, so an
// oversized action is not free. The gap after an obstacle is sized to let a
// correctly-sized action recover in time and no more - that is what gives width
// a consequence. See ROADMAP.md for why punishing via a tight gap alone cannot
// work: solvability needs a wide gap and punishment needs a narrow one.
export const GAP_BASE = 3;
export const gapFor = (width) => 2 * width + GAP_BASE;
export const MIN_GAP = gapFor(MAX_JUMP);      // worst-case gap, used for the lead-in
const EXTRA_GAP = 5;                 // random slack on top, for rhythm
export const START_STEP_MS = 260;
export const MIN_STEP_MS = 120;
export const RAMP_EVERY = 25;
export const RAMP_MS = 10;
const OBSTACLE_CHANCE = 0.35;
const MAX_OBSTACLE_CHANCE = 0.7;

// Speed alone plateaus: it reaches MIN_STEP_MS after SPEED_STEPS and then the
// game never gets harder again. Once it floors, difficulty keeps climbing as
// density instead - obstacles get likelier and the random slack in the gaps is
// squeezed out, down to the tightest spacing that is still provably clearable.
export const SPEED_STEPS =
  ((START_STEP_MS - MIN_STEP_MS) / RAMP_MS) * RAMP_EVERY;
const DENSITY_SPAN = 900;
export const difficulty = (step) =>
  Math.min(1, Math.max(0, (step - SPEED_STEPS) / DENSITY_SPAN));

// Which pose survives which cell.
const SURVIVES = { [LOW]: POSE.AIR, [HIGH]: POSE.DUCK };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Emits one lane cell at a time. `cooldown` is what makes every lane clearable:
// an obstacle is never started until MIN_GAP empty cells have gone by.
// Expands a pattern into cells, inserting the required gap after every item.
// Doing it here rather than in the pattern data means a pattern cannot express
// an unclearable spacing even by mistake.
function expand(pattern, rand, d) {
  const cells = [];
  // gapFor(width) is the tightest gap a correctly-sized action can clear; the
  // slack on top varies the rhythm and is squeezed out as difficulty rises, but
  // the floor is never crossed, so every lane stays clearable.
  const slack = Math.round(EXTRA_GAP * (1 - d));
  for (const [kind, width] of pattern.items) {
    for (let k = 0; k < width; k++) cells.push(kind);
    const gap = gapFor(width) + Math.floor(rand() * (slack + 1));
    for (let k = 0; k < gap; k++) cells.push(EMPTY);
  }
  return cells;
}

function createGenerator(rand, leadIn) {
  let buffer = [];
  let cooldown = leadIn;
  return function nextCell(step = 0) {
    if (buffer.length) return buffer.shift();
    if (cooldown > 0) { cooldown--; return EMPTY; }
    const d = difficulty(step);
    if (rand() < OBSTACLE_CHANCE + (MAX_OBSTACLE_CHANCE - OBSTACLE_CHANCE) * d) {
      buffer = expand(pickPattern(rand, step), rand, d);
      return buffer.shift();
    }
    return EMPTY;
  };
}

export function createGame(seed = Date.now()) {
  const nextCell = createGenerator(mulberry32(seed), PLAYER_COL + MIN_GAP);
  const lane = [];
  for (let i = 0; i < LANE_LEN; i++) lane.push(nextCell(0));
  return {
    seed, lane, nextCell,
    airCells: 0,      // cells still to be spent airborne, including this step
    duckCells: 0,     // same countdown for the crouch
    extendsLeft: 0,   // how much more the current jump or duck may be stretched
    actionWidth: 0,   // width committed to, which sets the recovery cost
    airSpan: 0,       // total airborne cells for this jump; sets the arc height
    duckHold: false,  // the duck key is down: hold the crouch instead of decaying
    groundCooldown: 0,// recovery cells owed after the current action ends
    // The pose the player held for the cell currently under them. This is the
    // display truth; airCells/duckCells are countdowns and drop a step ahead of it.
    poseNow: POSE.STAND,
    // Set when an action was started too late to cover the cell already arriving.
    // The action still happens - it just does not protect against that one cell.
    lateAction: false,
    step: 0, score: 0, alive: true, stepMs: START_STEP_MS,
  };
}

export function poseOf(g) {
  if (g.airCells > 0) return POSE.AIR;
  if (g.duckCells > 0) return POSE.DUCK;
  return POSE.STAND;
}

// action: null | {type:"jump"|"duck", width?}
// One type per verb. Starting the verb while already in it extends it instead.
// A human tap omits width; the agent sets it. Returns true if the input did
// something, so the caller can buffer a press that arrived during the cooldown.
export function applyAction(g, action) {
  if (!action || !g.alive) return false;
  const w = Math.min(MAX_JUMP, Math.max(1, Math.trunc(action.width ?? 1)));

  if (action.type === "jump") {
    if (g.airCells > 0) {                       // already airborne: extend
      if (g.extendsLeft <= 0) return false;
      g.airCells += 1;
      g.airSpan += 1;
      g.extendsLeft -= 1;
      g.actionWidth += 1;                       // a longer jump costs more recovery
      return true;
    }
    if (g.groundCooldown > 0) return false;
    g.duckCells = 0;                            // a jump cancels a crouch
    g.airCells = w + 1;
    g.airSpan = g.airCells;
    g.extendsLeft = MAX_AIR - g.airCells;
    g.actionWidth = w;
    return true;
  }

  if (action.type === "duck") {
    if (g.airCells > 0) return false;           // cannot crouch in mid-air
    if (g.duckCells > 0) {                      // already ducking: extend
      if (g.extendsLeft <= 0) return false;
      g.duckCells += 1;
      g.extendsLeft -= 1;
      g.actionWidth += 1;
      return true;
    }
    if (g.groundCooldown > 0) return false;
    g.duckCells = w + 1;
    g.extendsLeft = MAX_AIR - g.duckCells;
    g.actionWidth = w;
    return true;
  }

  return false;
}

// One logical tick = the lane advances exactly one cell.
export function step(g, action) {
  if (!g.alive) return g;

  applyAction(g, action);
  if (g.airCells === 0 && g.duckCells === 0 && g.groundCooldown > 0) g.groundCooldown--;

  g.lane.shift();
  g.lane.push(g.nextCell(g.step));
  g.step++;

  const pose = poseOf(g);
  g.poseNow = pose;
  // A late action still moves the player, it just forfeits protection this step.
  const covered = g.lateAction ? POSE.STAND : pose;
  g.lateAction = false;

  const cell = g.lane[PLAYER_COL];
  if (cell !== EMPTY && SURVIVES[cell] !== covered) {
    g.alive = false;
    return g;
  }

  g.score++;
  if (g.airCells > 0) {
    g.airCells--;
    if (g.airCells === 0) endAction(g);
  } else if (g.duckCells > 0 && !g.duckHold) {
    // While the key is held the crouch persists; releasing lets it end and charges
    // the recovery, so holding is not free but also not a per-cell cost.
    g.duckCells--;
    if (g.duckCells === 0) endAction(g);
  }
  if (g.step % RAMP_EVERY === 0) g.stepMs = Math.max(MIN_STEP_MS, g.stepMs - RAMP_MS);
  return g;
}

// Recovery is charged in proportion to what was committed, so over-committing is
// paid for even though the action itself succeeded.
function endAction(g) {
  g.extendsLeft = 0;
  // Doubling makes the cost superlinear, so one size too big overshoots the gap
  // by two cells while a correctly-sized action clears it with one to spare.
  // A linear cost lands exactly on the solvability boundary and breaks.
  g.groundCooldown = 2 * g.actionWidth;
  g.actionWidth = 0;
}

// What the agent sees. Deliberately tiny.
export function observe(g) {
  return {
    currentStep: g.step,
    lane: g.lane.join(""),
    playerIndex: PLAYER_COL,
    pose: poseOf(g),
  };
}
