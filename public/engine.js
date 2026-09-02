// Pure game logic. No DOM, no timers, no rendering.
// Runs unchanged in the browser and in Node (tests, headless agent runs).

export const LANE_WIDTH = 20;        // visible cells
export const LANE_LEN = LANE_WIDTH + 1; // one extra so cells slide in smoothly
export const PLAYER_COL = 2;
export const MAX_JUMP = 3;
// Airtime is width + 1. The spare cell absorbs the fact that a press lands at an
// arbitrary point inside a cell, and lets liftoff happen a step before contact.
export const MAX_AIR = MAX_JUMP + 1;
export const MIN_GAP = 4;            // empty cells forced after every obstacle
export const START_STEP_MS = 260;
export const MIN_STEP_MS = 120;
export const RAMP_EVERY = 25;
export const RAMP_MS = 10;
const OBSTACLE_CHANCE = 0.4;

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
function createGenerator(rand, leadIn) {
  let pending = 0;
  let cooldown = leadIn;
  return function nextCell() {
    if (pending > 0) { pending--; return 1; }
    if (cooldown > 0) { cooldown--; return 0; }
    if (rand() < OBSTACLE_CHANCE) {
      const width = 1 + Math.floor(rand() * MAX_JUMP);
      pending = width - 1;
      cooldown = MIN_GAP;
      return 1;
    }
    return 0;
  };
}

export function createGame(seed = Date.now()) {
  const nextCell = createGenerator(mulberry32(seed), PLAYER_COL + MIN_GAP);
  const lane = [];
  for (let i = 0; i < LANE_LEN; i++) lane.push(nextCell());
  return {
    seed, lane, nextCell,
    airCells: 0,      // cells still to be spent airborne, including this step
    extendsLeft: 0,   // how much more this jump may be stretched
    groundCooldown: 0,// forces one grounded step between jumps (no space-mashing)
    // Whether the player was airborne for the cell currently under them. This is
    // the display truth; airCells is the countdown and drops a step ahead of it.
    airborneNow: false,
    // Set when a jump was started too late to clear the cell already arriving.
    // The jump still happens - it just does not protect against that one cell.
    lateJump: false,
    step: 0, score: 0, alive: true, stepMs: START_STEP_MS,
  };
}

// action: null | {type:"jump", width?}
// One action type covers both cases: a jump while grounded starts one, a jump
// while airborne extends it. A human tap omits width; the agent sets it.
// Returns true if the input actually did something, so the caller can buffer a
// press that arrived during the post-landing cooldown instead of dropping it.
export function applyAction(g, action) {
  if (!action || !g.alive) return false;
  const airborne = g.airCells > 0;
  if (!airborne) {
    if (action.type !== "jump" || g.groundCooldown > 0) return false;
    const w = Math.min(MAX_JUMP, Math.max(1, Math.trunc(action.width ?? 1)));
    g.airCells = w + 1;
    g.extendsLeft = MAX_AIR - g.airCells;
    return true;
  }
  if (g.extendsLeft > 0) {
    g.airCells += 1;
    g.extendsLeft -= 1;
    return true;
  }
  return false;
}

// One logical tick = the lane advances exactly one cell.
export function step(g, action) {
  if (!g.alive) return g;

  applyAction(g, action);
  if (g.airCells === 0 && g.groundCooldown > 0) g.groundCooldown--;

  g.lane.shift();
  g.lane.push(g.nextCell());
  g.step++;

  const airborne = g.airCells > 0;
  g.airborneNow = airborne;
  const protectedNow = airborne && !g.lateJump;
  g.lateJump = false;
  if (!protectedNow && g.lane[PLAYER_COL] === 1) {
    g.alive = false;
    return g;
  }

  g.score++;
  if (airborne) {
    g.airCells--;
    if (g.airCells === 0) { g.extendsLeft = 0; g.groundCooldown = 1; }
  }
  if (g.step % RAMP_EVERY === 0) g.stepMs = Math.max(MIN_STEP_MS, g.stepMs - RAMP_MS);
  return g;
}

// What the agent sees. Deliberately tiny.
export function observe(g) {
  return {
    currentStep: g.step,
    lane: g.lane.join(""),
    playerIndex: PLAYER_COL,
    airborne: g.airCells > 0,
  };
}
