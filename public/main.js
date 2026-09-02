import { createGame, step, applyAction, observe, POSE } from "./engine.js";
import { setupCanvas, draw } from "./render.js";
import { EventBus } from "./agent/events.js";
import { createTools } from "./agent/tools.js";
import { Agent } from "./agent/agent.js";
import { heuristicPolicy, createLlmPolicy, createPlannerPolicy } from "./agent/policies.js";

const ctx = setupCanvas(document.getElementById("game"));
const $ = (id) => document.getElementById(id);
const logEl = $("log");

let game = createGame();
let mode = "human";      // "human" | "agent"
let running = false, paused = false, aborted = false;
let arming = false;   // agent mode: hold the world still until the first plan lands
let lastStepAt = 0;
let bufferedAction = null;   // a press that arrived during the landing cooldown
let prevPose = POSE.STAND;

// Agent state
const scheduled = new Map();   // atStep -> width
let inFlight = null;           // AbortController
let lastPlanStep = -999;
const REPLAN_EVERY = 5;        // steps
const LATE_PRESS = 0.45;       // fraction of a step after which a tap is too late

// --- agent wiring ---------------------------------------------------------
const events = new EventBus();
const tools = createTools({
  getGame: () => game,
  startGame: () => newGame("agent"),
  scheduleAction: (atStep, action, width) => scheduled.set(atStep, { action, width }),
  isRunning: () => running && !paused,
  setFrozen: (v) => { arming = v; if (!v) lastStepAt = performance.now(); setButtons(); stats(); },
});
let agent = null;

events.on((e) => {
  if (e.type === "observation_taken") return;   // too chatty for the panel
  const bits = { ...e };
  delete bits.type; delete bits.at;
  log(`[${e.type}] ${JSON.stringify(bits)}`);
});

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setButtons() {
  $("pause").disabled = !running;
  $("pause").textContent = paused ? "Continue" : "Pause";
  $("abort").disabled = !(running && mode === "agent" && !aborted);
}

function stats() {
  const state = !running ? (game.alive ? "ready" : "GAME OVER")
              : arming ? "arming" : paused ? "paused"
              : (aborted ? "aborted" : "running");
  $("stats").textContent =
    `mode ${mode} | ${state} | score ${game.score} | step ${game.step} | ${game.stepMs}ms/step`;
}

function newGame(nextMode) {
  game = createGame();
  mode = nextMode;
  running = true; paused = false; aborted = false; arming = false;
  bufferedAction = null;
  prevPose = POSE.STAND;
  scheduled.clear();
  lastPlanStep = -999;
  inFlight?.abort();
  inFlight = null;
  lastStepAt = performance.now();
  logEl.textContent = "";
  log(`--- new game (${nextMode}), seed ${game.seed} ---`);
  setButtons(); stats();
}

function gameOver() {
  running = false;
  inFlight?.abort();
  inFlight = null;
  log(`--- game over at step ${game.step}, score ${game.score} ---`);
  setButtons(); stats();
}

// --- agent planning -------------------------------------------------------
// The plan names absolute future step indices, so a slow response is harmless
// as long as it lands before the step it targets.
async function requestPlan() {
  inFlight = new AbortController();
  const obs = observe(game);
  try {
    const res = await fetch("/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obs),
      signal: inFlight.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const plan = await res.json();
    if (aborted) return;

    let added = 0;
    for (const a of plan.actions ?? []) {
      if (!Number.isInteger(a.atStep) || a.atStep <= game.step) continue;
      if (!Number.isInteger(a.width) || a.width < 1 || a.width > 3) continue;
      if (a.action !== "jump" && a.action !== "duck") continue;
      if (!scheduled.has(a.atStep)) added++;
      scheduled.set(a.atStep, { action: a.action, width: a.width });
    }
    log(`plan @${obs.currentStep} lane=${obs.lane} +${added} ` +
        `[${(plan.actions ?? []).map((a) => `${a.atStep}:${a.action}${a.width}`).join(" ")}]` +
        (plan.reasoning ? `\n  ${plan.reasoning}` : ""));
  } catch (err) {
    if (err.name !== "AbortError") log(`plan error: ${err.message}`);
  } finally {
    inFlight = null;
  }
}

function maybePlan() {
  if (agent) return;   // the agent owns scheduling when it is driving
  if (mode !== "agent" || aborted || paused || !running || inFlight) return;
  if (game.step - lastPlanStep < REPLAN_EVERY) return;
  lastPlanStep = game.step;
  requestPlan();
}

// --- main loop ------------------------------------------------------------
function tick(now) {
  requestAnimationFrame(tick);

  if (running && !paused && !arming && now - lastStepAt >= game.stepMs) {
    lastStepAt = now;

    // Act one step before the obstacle arrives, so the player is already in the
    // pose as it slides in rather than moving on the frame of contact.
    const dueAt = game.step + 2;
    const due = scheduled.get(dueAt);
    if (due !== undefined) {
      scheduled.delete(dueAt);
      applyAction(game, { type: due.action, width: due.width });
    }
    prevPose = game.poseNow;
    step(game, null);

    // A press made during the post-landing cooldown is replayed here, once the
    // step has cleared that cooldown, rather than being silently dropped.
    if (bufferedAction && applyAction(game, { type: bufferedAction })) bufferedAction = null;
    for (const k of scheduled.keys()) if (k <= game.step + 1) scheduled.delete(k);

    if (!game.alive) gameOver(); else { maybePlan(); stats(); }
  }

  const alpha = running && !paused && !arming
    ? Math.min(1, (now - lastStepAt) / game.stepMs)
    : 1;
  draw(ctx, game, alpha, prevPose);
}
requestAnimationFrame(tick);

// --- input ----------------------------------------------------------------
const stepAge = () => (performance.now() - lastStepAt) / game.stepMs;

function humanPress(type = "jump") {
  if (mode !== "human" || !running || paused) return;
  // Always applied on the keypress itself, so the action is never visually
  // delayed. A press that arrives too late still moves the player - it just
  // forfeits protection against the cell already sliding on, so you clip it.
  const late = stepAge() >= LATE_PRESS;
  const wasIdle = game.airCells === 0 && game.duckCells === 0;
  const applied = applyAction(game, { type });
  if (applied && late && wasIdle) game.lateAction = true;
  bufferedAction = applied ? null : type;
}

const KEYS = { Space: "jump", ArrowDown: "duck", KeyS: "duck" };

addEventListener("keydown", (e) => {
  const type = KEYS[e.code];
  if (!type) return;
  e.preventDefault();
  if (e.repeat) return;              // ignore key auto-repeat from a held key
  humanPress(type);
});

$("start").onclick = () => { agent?.stop("human took over"); agent = null; newGame("human"); };
$("agent").onclick = () => {
  agent?.stop("restarted");
  const policies = {
    "llm-batch": createPlannerPolicy,   // one call covers every visible obstacle
    "llm": createLlmPolicy,             // one call per obstacle
    "heuristic": () => heuristicPolicy,
  };
  agent = new Agent({
    tools,
    policy: (policies[$("policy").value] ?? policies.heuristic)(),
    fallback: heuristicPolicy,
    events,
  });
  agent.run();          // Agent.startGame() resets the world itself
};

// The original one-shot planner, kept so the two approaches can be compared.
$("planner").onclick = async () => {
  agent?.stop("switched to planner");
  agent = null;
  newGame("agent");
  arming = true;
  log("arming: waiting for the first plan...");
  lastPlanStep = game.step;
  await requestPlan();
  arming = false;
  lastStepAt = performance.now();
};
$("pause").onclick = () => {
  paused = !paused;
  agent?.setPaused(paused);
  lastStepAt = performance.now();
  if (!paused) maybePlan();
  setButtons(); stats();
};
$("abort").onclick = () => {
  aborted = true;
  agent?.stop("user aborted");
  agent = null;
  inFlight?.abort();
  inFlight = null;
  scheduled.clear();
  log("--- agent aborted; game runs on until it hits something ---");
  setButtons(); stats();
};

setButtons(); stats();

// Debug handle: inspect live state or inject a press from the console.
globalThis.dbg = {
  get game() { return game; },
  get scheduled() { return scheduled; },
  get agent() { return agent; },
  events,
  tools,
  press: humanPress,
  duck: () => humanPress("duck"),
  stepAge,
};
