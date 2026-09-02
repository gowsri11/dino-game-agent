#!/usr/bin/env node
// Headless policy benchmark. engine.js is pure, so a run needs no browser.
//
// Runs in virtual time rather than real time: a policy call is awaited, the real
// latency is measured, and the world is then advanced by the number of steps that
// latency would have cost. A slow model loses exactly the steps it would lose in
// the browser, but the benchmark finishes as fast as the calls allow.
//
//   node bench.mjs --policy heuristic --seeds 50
//   node bench.mjs --policy llm-batch --seeds 10 --base http://localhost:3000
import { createGame, step, applyAction, PLAYER_COL } from "./public/engine.js";
import { observeGameState } from "./public/agent/observer.js";
import {
  heuristicPolicy, heuristicPlanner, createLlmPolicy, createPlannerPolicy,
  validateDecision, validatePlan, PLANNING_WINDOW,
} from "./public/agent/policies.js";

const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, v]) => [k, v ?? "true"]));

const SEEDS = Number(args.seeds ?? 25);
const MAX_STEPS = Number(args["max-steps"] ?? 1500);
const BASE = args.base ?? "http://localhost:3000";
const REPLAN_EVERY = 5;

const POLICIES = {
  heuristic: () => heuristicPolicy,
  "heuristic-batch": () => heuristicPlanner,
  llm: () => createLlmPolicy({ endpoint: `${BASE}/act` }),
  "llm-batch": () => createPlannerPolicy({ endpoint: `${BASE}/plan` }),
};

// One run. Mirrors the browser loop's contract: actions name absolute future
// steps, and the loop fires them one step before the obstacle lands.
async function runOne(seed, policy, stats) {
  const g = createGame(seed);
  const scheduled = new Map();
  const handled = new Set();
  let lastPlanStep = -Infinity;

  const advance = (n) => {
    for (let i = 0; i < n && g.alive && g.step < MAX_STEPS; i++) {
      const dueAt = g.step + 2;
      const due = scheduled.get(dueAt);
      if (due !== undefined) {
        scheduled.delete(dueAt);
        applyAction(g, { type: due.action, width: due.width });
      }
      for (const k of scheduled.keys()) if (k <= g.step + 1) scheduled.delete(k);
      step(g, null);
    }
  };

  // Charge the world the steps the call really cost.
  const timed = async (fn) => {
    const t0 = performance.now();
    const out = await fn();
    const ms = performance.now() - t0;
    stats.latencies.push(ms);
    advance(Math.floor(ms / g.stepMs));
    return out;
  };

  const commit = (actions, source) => {
    for (const a of actions) {
      if (a.atStep <= g.step + 1) { stats.missed++; continue; }
      scheduled.set(a.atStep, { action: a.action, width: a.width });
      handled.add(a.atStep);
      stats.executed++;
    }
    stats.bySource[source] = (stats.bySource[source] ?? 0) + 1;
  };

  while (g.alive && g.step < MAX_STEPS) {
    const state = observeGameState(g);

    if (policy.plan) {
      if (g.step - lastPlanStep >= (policy.replanEverySteps ?? REPLAN_EVERY)) {
        lastPlanStep = g.step;
        let plan = null, source = policy.name;
        try {
          plan = validatePlan(await timed(() => policy.plan(state)), state);
        } catch (err) {
          stats.errors++;
        }
        if (!plan) {
          stats.fallbacks++;
          source = heuristicPlanner.name;
          plan = validatePlan(await heuristicPlanner.plan(state), state);
        }
        if (plan) commit(plan.actions, source);
      }
      advance(1);
      continue;
    }

    const target = (state.obstacles ?? []).find(
      (o) => !handled.has(o.arrivesAtStep) && o.distance <= PLANNING_WINDOW);
    if (!target) { advance(1); continue; }

    const policyState = { ...state, nearestObstacle: target };
    let decision = null, source = policy.name;
    try {
      decision = validateDecision(await timed(() => policy.decide(policyState)), policyState);
    } catch (err) {
      stats.errors++;
    }
    if (!decision) {
      stats.fallbacks++;
      source = heuristicPolicy.name;
      decision = validateDecision(await heuristicPolicy.decide(policyState), policyState);
    }
    if (decision && decision.action !== "wait") {
      commit([{ atStep: target.arrivesAtStep, ...decision }], source);
    }
    advance(1);
  }

  return { seed, score: g.score, survived: g.alive };
}

const pct = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] : 0;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const name = args.policy ?? "heuristic";
const make = POLICIES[name];
if (!make) {
  console.error(`unknown policy "${name}". try: ${Object.keys(POLICIES).join(", ")}`);
  process.exit(1);
}

const stats = { latencies: [], missed: 0, executed: 0, fallbacks: 0, errors: 0, bySource: {} };
const results = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  results.push(await runOne(seed, make(), stats));
  process.stderr.write(`\r${name}: ${seed}/${SEEDS}`);
}
process.stderr.write("\n");

const scores = results.map((r) => r.score);
const survived = results.filter((r) => r.survived).length;
console.log(JSON.stringify({
  policy: name,
  seeds: SEEDS,
  maxSteps: MAX_STEPS,
  score: {
    mean: Math.round(mean(scores)),
    median: pct(scores, 0.5),
    min: Math.min(...scores),
    max: Math.max(...scores),
  },
  reachedCap: `${survived}/${SEEDS}`,
  actions: { executed: stats.executed, missed: stats.missed },
  policyLatencyMs: stats.latencies.length
    ? { mean: Math.round(mean(stats.latencies)), p90: Math.round(pct(stats.latencies, 0.9)) }
    : null,
  fallbacks: stats.fallbacks,
  errors: stats.errors,
}, null, 2));
