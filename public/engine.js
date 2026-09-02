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
const HIGH_CHANCE = 0.35;            // share of obstacles that must be ducked

// Cell kinds. A low obstacle must be jumped, a high one must be ducked under.
// Standing upright is fatal to both, so every obstacle asks which verb, not just
// when - that is where the skill lives, and it needs no timing margin to express.
export const EMPTY = 0;
export const LOW = 1;
export const HIGH = 2;

// Which pose survives which cell.
export const POSE = { STAND: "stand", AIR: "air", DUCK: "duck" };
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
function createGenerator(rand, leadIn) {
  let pending = 0;
  let pendingKind = LOW;
  let cooldown = leadIn;
  return function nextCell() {
    if (pending > 0) { pending--; return pendingKind; }
    if (cooldown > 0) { cooldown--; return EMPTY; }
    if (rand() < OBSTACLE_CHANCE) {
      const width = 1 + Math.floor(rand() * MAX_JUMP);
      pendingKind = rand() < HIGH_CHANCE ? HIGH : LOW;
      pending = width - 1;
      cooldown = MIN_GAP;
      return pendingKind;
    }
    return EMPTY;
  };
}

export function createGame(seed = Date.now()) {
  const nextCell = createGenerator(mulberry32(seed), PLAYER_COL + MIN_GAP);
  const lane = [];
  for (let i = 0; i < LANE_LEN; i++) lane.push(nextCell());
  return {
    seed, lane, nextCell,
    airCells: 0,      // cells still to be spent airborne, including this step
    duckCells: 0,     // same countdown for the crouch
    extendsLeft: 0,   // how much more the current jump or duck may be stretched
    groundCooldown: 0,// forces one grounded step between jumps (no space-mashing)
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
      g.extendsLeft -= 1;
      return true;
    }
    if (g.groundCooldown > 0) return false;
    g.duckCells = 0;                            // a jump cancels a crouch
    g.airCells = w + 1;
    g.extendsLeft = MAX_AIR - g.airCells;
    return true;
  }

  if (action.type === "duck") {
    if (g.airCells > 0) return false;           // cannot crouch in mid-air
    if (g.duckCells > 0) {                      // already ducking: extend
      if (g.extendsLeft <= 0) return false;
      g.duckCells += 1;
      g.extendsLeft -= 1;
      return true;
    }
    g.duckCells = w + 1;
    g.extendsLeft = MAX_AIR - g.duckCells;
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
    if (g.airCells === 0) { g.extendsLeft = 0; g.groundCooldown = 1; }
  } else if (g.duckCells > 0) {
    g.duckCells--;
    if (g.duckCells === 0) g.extendsLeft = 0;
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
    pose: poseOf(g),
  };
}
