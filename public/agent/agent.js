// The Agent owns the control loop. The LLM is only the decision policy inside it.
import {
  heuristicPolicy, heuristicPlanner, validateDecision, validatePlan, PLANNING_WINDOW,
} from "./policies.js";

const WAIT = { action: "wait", width: 0, reason: "default" };

export class Agent {
  constructor({ tools, policy, events, fallback = heuristicPolicy, config = {} }) {
    this.tools = tools;
    this.policy = policy;
    this.fallback = fallback;
    this.events = events;
    this.config = {
      intervalMs: 100,               // decision cadence; the render loop is untouched
      planningWindow: PLANNING_WINDOW,
      ...config,
    };
    this.running = false;
    this.paused = false;
    this.abort = null;
    // Arrival steps we have already committed a jump for, so one obstacle costs
    // at most one decision no matter how often the loop observes it.
    this.handled = new Set();
    // Arrival steps with a decision currently in flight. Without this the loop
    // would block ~1.2s per decision and fall behind the game.
    this.pending = new Set();
    this.planInFlight = false;
    this.lastPlanStep = -Infinity;
  }

  stop(reason = "aborted") {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    this.events.emit("agent_stopped", { reason });
  }

  setPaused(paused) { this.paused = paused; }

  async run() {
    this.running = true;
    this.abort = new AbortController();
    this.handled.clear();
    this.events.emit("agent_started", {
      policy: this.policy.name,
      fallback: this.fallback.name,
      intervalMs: this.config.intervalMs,
    });

    this.tools.startGame();

    // The opening decision costs a round-trip while the first obstacle is only a
    // few steps out, so take it with the world held still.
    this.tools.freeze();
    try {
      await this.cycle({ blocking: true });
    } finally {
      this.tools.unfreeze();
    }

    while (this.running && !this.tools.isGameOver()) {
      if (this.paused) { await this.tools.waitMs(this.config.intervalMs); continue; }
      await this.cycle();
      await this.tools.waitMs(this.config.intervalMs);
    }

    if (this.tools.isGameOver()) {
      this.events.emit("game_over", { score: this.tools.getScore() });
    }
    this.running = false;
  }

  // One observe -> decide -> execute pass. The decision is dispatched rather than
  // awaited, so the loop keeps its cadence while the policy is thinking. Only the
  // opening decision blocks, and the world is frozen for that one.
  async cycle({ blocking = false } = {}) {
    const state = this.tools.observeGameState();
    this.events.emit("observation_taken", { state });

    // A policy exposes either plan() (one call covers every visible obstacle) or
    // decide() (one call per obstacle). The loop, tools and events are identical.
    if (this.policy.plan) return this.cyclePlan(state, blocking);

    const target = this.selectTarget(state);
    if (!target) {
      const decision = { ...WAIT, reason: "nothing left to commit to in view", source: "agent" };
      this.events.emit("action_selected", { decision, step: state.game.step });
      return decision;
    }

    const inFlight = this.dispatch(state, target);
    if (blocking) await inFlight;
    return null;
  }

  // --- batch path ----------------------------------------------------------
  async cyclePlan(state, blocking) {
    const every = this.policy.replanEverySteps ?? 5;
    const due = state.game.step - this.lastPlanStep >= every;
    if (this.planInFlight || (!due && !blocking)) return null;
    if (!(state.obstacles ?? []).length && !blocking) return null;

    this.lastPlanStep = state.game.step;
    const inFlight = this.dispatchPlan(state);
    if (blocking) await inFlight;
    return null;
  }

  async dispatchPlan(state) {
    this.planInFlight = true;
    try {
      let plan;
      try {
        const raw = await this.policy.plan(state, { signal: this.abort.signal });
        plan = validatePlan(raw, state);
        if (!plan) this.events.emit("policy_fallback", { why: "invalid plan", raw });
      } catch (err) {
        if (err.name === "AbortError") return;
        this.events.emit("policy_fallback", { why: err.message });
      }

      const source = plan ? this.policy.name : heuristicPlanner.name;
      if (!plan) plan = validatePlan(await heuristicPlanner.plan(state), state);
      if (!this.running || !plan) return;

      this.events.emit("action_selected", {
        decision: { action: plan.actions.length ? "jump" : "wait",
                    reason: plan.reason, source, count: plan.actions.length },
        step: state.game.step,
      });

      // Re-read the clock: entries whose step has already passed are dropped, and
      // the next plan will cover them again. Writes are keyed by absolute step, so
      // re-planning the same obstacle overwrites rather than duplicates.
      const now = this.tools.observeGameState().game.step;
      for (const a of plan.actions) {
        if (a.atStep <= now + 1) {
          this.events.emit("action_missed", { arrivesAtStep: a.atStep, step: now, source });
          continue;
        }
        const result = this.tools.scheduleJump(a.atStep, a.width);
        this.events.emit("action_executed", { tool: "scheduleJump", ...result, source });
      }
    } finally {
      this.planInFlight = false;
    }
  }

  // --- per-obstacle path -----------------------------------------------------
  async dispatch(state, target) {
    this.pending.add(target.arrivesAtStep);
    try {
      const decision = await this.decide(state, target);
      if (!this.running) return;
      this.events.emit("action_selected", { decision, step: state.game.step });
      this.execute(decision, target);
    } finally {
      this.pending.delete(target.arrivesAtStep);
    }
  }

  // The first obstacle we have not already committed a jump for. Looking past
  // handled ones is what gives the next decision a full round-trip of runway.
  selectTarget(state) {
    return (state.obstacles ?? []).find(
      (o) => !this.handled.has(o.arrivesAtStep)
          && !this.pending.has(o.arrivesAtStep)
          && o.distance <= this.config.planningWindow,
    ) ?? null;
  }

  // Decide whether this observation is even worth a model call, then ask the
  // policy, then validate. Any failure degrades to the heuristic, never to a throw.
  async decide(state, target = this.selectTarget(state)) {
    if (!target) {
      return { ...WAIT, reason: "nothing left to commit to in view", source: "agent" };
    }
    // Note: being airborne does NOT block a decision. We are scheduling a jump for
    // a future step, not jumping now, so the current pose is irrelevant here.
    const policyState = { ...state, nearestObstacle: target };

    try {
      const raw = await this.policy.decide(policyState, { signal: this.abort.signal });
      const valid = validateDecision(raw, policyState);
      if (valid) return { ...valid, source: this.policy.name };
      this.events.emit("policy_fallback", { why: "invalid response", raw });
    } catch (err) {
      if (err.name === "AbortError") return { ...WAIT, reason: "aborted", source: "agent" };
      this.events.emit("policy_fallback", { why: err.message });
    }

    const backup = await this.fallback.decide(policyState);
    return { ...validateDecision(backup, policyState) ?? WAIT, source: this.fallback.name };
  }

  execute(decision, target) {
    if (decision.action !== "jump" || !target) return;

    // arrivesAtStep is absolute, so it stays correct however long the policy took.
    // Only the current step needs re-reading.
    const fresh = this.tools.observeGameState();
    const ob = target;

    if (ob.arrivesAtStep <= fresh.game.step + 1) {
      // Too late to schedule. Do nothing: jumping at an arbitrary moment for an
      // obstacle that has already gone is worse than missing it quietly, and it
      // burns the landing cooldown needed for the next one. Deliberately does NOT
      // mark the obstacle handled, so a retry is still possible.
      this.events.emit("action_missed", {
        arrivesAtStep: ob.arrivesAtStep, step: fresh.game.step, source: decision.source,
      });
      return;
    }

    // Liftoff is scheduled against the obstacle's arrival step; the game loop
    // fires it a step early, which is what the width+1 airtime pays for.
    const result = this.tools.scheduleJump(ob.arrivesAtStep, decision.width);
    this.handled.add(ob.arrivesAtStep);   // only after it actually landed in the queue
    this.events.emit("action_executed", { tool: "scheduleJump", ...result, source: decision.source });
  }
}
