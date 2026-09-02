import test from "node:test";
import assert from "node:assert/strict";
import { createGame, LANE_LEN, PLAYER_COL, EMPTY, LOW, HIGH } from "../public/engine.js";
import { observeGameState } from "../public/agent/observer.js";
import {
  validateDecision, validatePlan, heuristicPolicy, heuristicPlanner,
} from "../public/agent/policies.js";
import { Agent } from "../public/agent/agent.js";
import { EventBus } from "../public/agent/events.js";

function gameWithObstacle(at, width, kind = LOW) {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  for (let k = 0; k < width; k++) g.lane[at + k] = kind;
  g.nextCell = () => EMPTY;
  g.step = 100;
  return g;
}

test("observer reports the nearest obstacle's width, distance and arrival step", () => {
  const g = gameWithObstacle(PLAYER_COL + 5, 3);
  const s = observeGameState(g);
  assert.equal(s.nearestObstacle.width, 3);
  assert.equal(s.nearestObstacle.distance, 5);
  assert.equal(s.nearestObstacle.arrivesAtStep, 105);
  assert.equal(s.nearestObstacle.kind, "low");
  assert.equal(s.nearestObstacle.requiredAction, "jump");
  assert.equal(s.dino.isGrounded, true);
  assert.deepEqual(s.allowedActions, ["jump", "duck", "wait"]);
});

test("observer marks high obstacles as needing a duck", () => {
  const s = observeGameState(gameWithObstacle(PLAYER_COL + 3, 2, HIGH));
  assert.equal(s.nearestObstacle.kind, "high");
  assert.equal(s.nearestObstacle.requiredAction, "duck");
  assert.equal(s.nearestObstacle.width, 2);
});

test("observer reports no obstacle on an empty lane", () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  assert.equal(observeGameState(g).nearestObstacle, null);
});

test("validateDecision rejects junk and constrains width", () => {
  const state = observeGameState(gameWithObstacle(PLAYER_COL + 4, 2));

  for (const bad of [null, undefined, "jump", {}, { action: "fly" }, { action: "" }]) {
    assert.equal(validateDecision(bad, state), null, `should reject ${JSON.stringify(bad)}`);
  }

  assert.deepEqual(validateDecision({ action: "wait", reason: "x" }, state),
    { action: "wait", width: 0, reason: "x" });
  assert.equal(validateDecision({ action: "duck", width: 2 }, state).action, "duck");

  // Out-of-range or missing widths fall back to the width actually observed.
  for (const w of [0, 9, -1, "two", undefined, 2.5]) {
    assert.equal(validateDecision({ action: "jump", width: w }, state).width, 2);
  }
  assert.equal(validateDecision({ action: "jump", width: 3 }, state).width, 3);
});

test("heuristic policy jumps at a near obstacle and waits otherwise", async () => {
  const near = observeGameState(gameWithObstacle(PLAYER_COL + 3, 2));
  assert.equal((await heuristicPolicy.decide(near)).action, "jump");
  assert.equal((await heuristicPolicy.decide(near)).width, 2);

  const high = observeGameState(gameWithObstacle(PLAYER_COL + 3, 2, HIGH));
  assert.equal((await heuristicPolicy.decide(high)).action, "duck",
    "the heuristic must pick the verb the obstacle requires");

  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  assert.equal((await heuristicPolicy.decide(observeGameState(g))).action, "wait");
});

// --- Agent.decide / execute, with stub tools so no timers are involved --------
function stubAgent(game, policy) {
  const events = new EventBus();
  const scheduled = [];
  const tools = {
    startGame() {}, resetGame() {}, freeze() {}, unfreeze() {},
    observeGameState: () => observeGameState(game),
    scheduleAction: (atStep, action, width) => {
      scheduled.push({ atStep, action, width });
      return { atStep, action, width };
    },
    waitMs: async () => {}, waitTicks: async () => {},
    getScore: () => game.score, isGameOver: () => !game.alive,
  };
  const agent = new Agent({ tools, policy, events });
  agent.abort = new AbortController();
  agent.running = true;          // dispatch paths bail out when the agent is stopped
  return { agent, events, scheduled };
}

test("agent does not consult the policy when nothing is in the planning window", async () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(0);                 // empty lane: nothing to decide
  g.nextCell = () => EMPTY;
  g.step = 100;
  let called = 0;
  const { agent } = stubAgent(g, { name: "spy", decide: async () => { called++; return { action: "jump" }; } });
  const d = await agent.decide(observeGameState(g));
  assert.equal(called, 0, "policy must not be called outside the planning window");
  assert.equal(d.action, "wait");
});

test("agent commits once per obstacle and schedules against its arrival step", async () => {
  const g = gameWithObstacle(PLAYER_COL + 4, 3);
  let called = 0;
  const { agent, scheduled } = stubAgent(g, {
    name: "spy",
    decide: async () => { called++; return { action: "jump", width: 3, reason: "r" }; },
  });

  const state = observeGameState(g);
  const target = agent.selectTarget(state);
  agent.execute(await agent.decide(state, target), target);
  assert.deepEqual(scheduled, [{ atStep: 104, action: "jump", width: 3 }]);

  // Observing the same obstacle again must not spend another call.
  const second = await agent.decide(observeGameState(g));
  assert.equal(second.action, "wait");
  assert.equal(called, 1, "one decision per obstacle");
});

test("agent falls back to the heuristic when the policy throws or returns junk", async () => {
  for (const broken of [
    { name: "boom", decide: async () => { throw new Error("llm exploded"); } },
    { name: "junk", decide: async () => ({ action: "levitate" }) },
  ]) {
    const g = gameWithObstacle(PLAYER_COL + 3, 2);
    const { agent, events } = stubAgent(g, broken);
    const d = await agent.decide(observeGameState(g));
    assert.equal(d.action, "jump", `${broken.name} should fall back to a heuristic jump`);
    assert.equal(d.source, "heuristic");
    assert.ok(events.history.some((e) => e.type === "policy_fallback"),
      `${broken.name} should emit policy_fallback`);
  }
});

test("agent still commits while airborne - it is scheduling, not jumping now", async () => {
  const g = gameWithObstacle(PLAYER_COL + 6, 1);
  g.airCells = 2;                                   // mid-jump over something else
  const { agent } = stubAgent(g, {
    name: "spy", decide: async () => ({ action: "jump", width: 1, reason: "r" }),
  });
  assert.equal((await agent.decide(observeGameState(g))).action, "jump");
});

test("agent looks past obstacles it has already committed to", async () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  g.lane[PLAYER_COL + 3] = 1;                       // first obstacle,  arrives 103
  g.lane[PLAYER_COL + 9] = 1;                       // second obstacle, arrives 109
  g.lane[PLAYER_COL + 10] = 1;
  g.nextCell = () => EMPTY;
  g.step = 100;

  const seen = [];
  const { agent, scheduled } = stubAgent(g, {
    name: "spy",
    decide: async (st) => {
      seen.push(st.nearestObstacle.arrivesAtStep);
      return { action: st.nearestObstacle.requiredAction,
               width: st.nearestObstacle.width, reason: "r" };
    },
  });

  for (let i = 0; i < 3; i++) {
    const state = observeGameState(g);
    const target = agent.selectTarget(state);
    agent.execute(await agent.decide(state, target), target);
  }

  assert.deepEqual(seen, [103, 109], "second decision must target the next uncommitted obstacle");
  assert.deepEqual(scheduled, [
    { atStep: 103, action: "jump", width: 1 },
    { atStep: 109, action: "jump", width: 2 },
  ]);
});


// --- fixes: never jump at an arbitrary moment, never lose an obstacle --------

test("a decision that arrives too late does nothing and is not marked handled", async () => {
  const g = gameWithObstacle(PLAYER_COL + 4, 2);
  const { agent, events, scheduled } = stubAgent(g, {
    name: "slow", decide: async () => ({ action: "jump", width: 2, reason: "r" }),
  });

  const state = observeGameState(g);
  const target = agent.selectTarget(state);          // arrives at step 104
  g.step = 104;                                      // the world moved on meanwhile

  agent.execute(await agent.decide(state, target), target);

  assert.deepEqual(scheduled, [], "must not jump at an arbitrary moment");
  assert.ok(events.history.some((e) => e.type === "action_missed"), "should report the miss");
  assert.equal(agent.handled.has(104), false, "a missed obstacle must stay retryable");
});

test("validatePlan drops past, duplicate and malformed entries", () => {
  const g = gameWithObstacle(PLAYER_COL + 5, 3);
  const state = observeGameState(g);                 // step 100, obstacle arrives 105

  assert.equal(validatePlan(null, state), null);
  assert.equal(validatePlan({ actions: "nope" }, state), null);

  const out = validatePlan({
    reason: "x",
    actions: [
      { atStep: 99, action: "jump", width: 1 },      // already past
      { atStep: 105, action: "jump", width: 3 },     // good
      { atStep: 105, action: "jump", width: 2 },     // duplicate step
      { atStep: 110, action: "jump", width: 9 },     // bad width, no matching obstacle
      { atStep: "x", action: "jump", width: 1 },     // malformed
    ],
  }, state);
  assert.deepEqual(out.actions, [{ atStep: 105, action: "jump", width: 3 }]);
});

test("batch policy schedules every visible obstacle in one call", async () => {
  const g = createGame(1);
  g.lane = Array(LANE_LEN).fill(EMPTY);
  g.lane[PLAYER_COL + 4] = 1;                        // arrives 104
  g.lane[PLAYER_COL + 9] = 1;                        // arrives 109
  g.lane[PLAYER_COL + 10] = 1;
  g.nextCell = () => EMPTY;
  g.step = 100;

  let calls = 0;
  const { agent, scheduled } = stubAgent(g, {
    name: "batch",
    replanEverySteps: 5,
    async plan(state) {
      calls++;
      return { reason: "r", actions: state.obstacles.map((o) => ({
        atStep: o.arrivesAtStep, action: o.requiredAction, width: o.width,
      })) };
    },
  });

  await agent.dispatchPlan(observeGameState(g));
  assert.equal(calls, 1, "one call covers every obstacle");
  assert.deepEqual(scheduled, [
    { atStep: 104, action: "jump", width: 1 },
    { atStep: 109, action: "jump", width: 2 },
  ]);
});

test("batch policy falls back to the heuristic planner when the call fails", async () => {
  const g = gameWithObstacle(PLAYER_COL + 6, 2);
  const { agent, events, scheduled } = stubAgent(g, {
    name: "batch", plan: async () => { throw new Error("llm exploded"); },
  });

  await agent.dispatchPlan(observeGameState(g));
  assert.deepEqual(scheduled, [{ atStep: 106, action: "jump", width: 2 }]);
  assert.ok(events.history.some((e) => e.type === "policy_fallback"));
  const exec = events.history.find((e) => e.type === "action_executed");
  assert.equal(exec.source, heuristicPlanner.name);
});

test("re-planning the same obstacle overwrites rather than duplicating", async () => {
  const g = gameWithObstacle(PLAYER_COL + 8, 3);
  const seen = new Map();
  const { agent } = stubAgent(g, {
    name: "batch",
    async plan(state) {
      return { reason: "r", actions: state.obstacles.map((o) => ({
        atStep: o.arrivesAtStep, action: o.requiredAction, width: o.width,
      })) };
    },
  });
  agent.tools.scheduleAction = (atStep, action, width) => {
    seen.set(atStep, { action, width });
    return { atStep, action, width };
  };

  await agent.dispatchPlan(observeGameState(g));
  await agent.dispatchPlan(observeGameState(g));
  assert.equal(seen.size, 1, "absolute step keys make repeated plans idempotent");
});
