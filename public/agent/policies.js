// DecisionPolicy: anything with { name, decide(state, opts) -> {action, width, reason} }
// or { name, plan(state, opts) -> {actions:[{atStep, action, width}], reason} }.
// Swappable so the LLM can be replaced by the heuristic (or anything else) later.
import { MAX_JUMP } from "../engine.js";

export const DANGER_DISTANCE = 12;   // steps; inside this the heuristic acts
// The loop blocks for a model round-trip (~1.2s, i.e. ~5 steps), so decisions are
// requested as soon as an obstacle is visible at all, to maximise the runway.
export const PLANNING_WINDOW = 22;

// Normalises and range-checks whatever the model returned. Anything unusable
// returns null so the caller can fall back to "wait" or to the heuristic.
export function validateDecision(raw, state) {
  if (!raw || typeof raw !== "object") return null;
  const action = String(raw.action ?? "").toLowerCase();
  if (!state.allowedActions.includes(action)) return null;

  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "";
  if (action === "wait") return { action: "wait", width: 0, reason };

  // Default to the width the observer actually measured; the model may override
  // it but only within range.
  const observed = state.nearestObstacle?.width ?? 1;
  let width = Number(raw.width);
  if (!Number.isInteger(width) || width < 1 || width > MAX_JUMP) width = observed;
  return { action, width, reason };
}

export const heuristicPolicy = {
  name: "heuristic",
  async decide(state) {
    const ob = state.nearestObstacle;
    if (ob && ob.distance <= DANGER_DISTANCE) {
      return { action: ob.requiredAction, width: ob.width,
               reason: `${ob.kind} w${ob.width} in ${ob.distance} steps` };
    }
    return { action: "wait", width: 0, reason: "nothing within danger distance" };
  },
};

// Batch policy: one call covers every visible obstacle. Re-issued on a step
// cadence, so each obstacle is covered by several successive plans - a single
// slow response is then harmless, which is the property the per-obstacle policy
// lacks. Writes are idempotent because they are keyed by absolute arrival step.
export function validatePlan(raw, state) {
  const list = Array.isArray(raw?.actions) ? raw.actions : null;
  if (!list) return null;
  const seen = new Set();
  const actions = [];
  for (const a of list) {
    const atStep = Number(a?.atStep);
    if (!Number.isInteger(atStep) || atStep <= state.game.step) continue;
    if (seen.has(atStep)) continue;

    // Fall back to what the observer measured for this arrival step, so a model
    // that names the right obstacle but the wrong verb or width is still usable.
    const match = state.obstacles?.find((o) => o.arrivesAtStep === atStep);
    let action = String(a?.action ?? "").toLowerCase();
    if (action !== "jump" && action !== "duck") {
      if (!match) continue;
      action = match.requiredAction;
    }
    let width = Number(a?.width);
    if (!Number.isInteger(width) || width < 1 || width > MAX_JUMP) {
      if (!match) continue;
      width = match.width;
    }

    seen.add(atStep);
    actions.push({ atStep, action, width });
  }
  return { actions, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "" };
}

export function createPlannerPolicy({ endpoint = "/plan", timeoutMs = 4000 } = {}) {
  return {
    name: "llm-batch",
    replanEverySteps: 5,
    async plan(state, { signal } = {}) {
      const timer = new AbortController();
      const onAbort = () => timer.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => timer.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(state),
          signal: timer.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// The heuristic answers the batch shape too, so it can back either policy.
export const heuristicPlanner = {
  name: "heuristic-batch",
  replanEverySteps: 5,
  async plan(state) {
    return {
      reason: "all visible obstacles",
      actions: (state.obstacles ?? []).map((o) => ({
        atStep: o.arrivesAtStep, action: o.requiredAction, width: o.width,
      })),
    };
  },
};

export function createLlmPolicy({ endpoint = "/act", timeoutMs = 2500 } = {}) {
  return {
    name: "llm",
    async decide(state, { signal } = {}) {
      // Bound the call: a slow answer is as useless as a failed one, because the
      // obstacle keeps moving while we wait.
      const timer = new AbortController();
      const onAbort = () => timer.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => timer.abort(), timeoutMs);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(state),
          signal: timer.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
        return await res.json();
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
