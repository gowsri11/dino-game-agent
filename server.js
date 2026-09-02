import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT ?? 3000);

// OpenAI-compatible endpoint (LiteLLM proxy).
const LLM_BASE = process.env.LLM_BASE_URL;
const LLM_KEY = process.env.LLM_API_KEY ?? "";
const MODEL = process.env.MODEL ?? "openrouter/openai/gpt-4o-mini";

const SYSTEM = `You play a side-scrolling obstacle game on a one-dimensional lane.

THE LANE
- \`lane\` is a string of 0s and 1s shown for context. The player stands at index 2.
- Every step the lane shifts one cell left, so an obstacle "arrives" under the player
  after a known number of steps.
- The obstacles have ALREADY been parsed for you: each one lists its width and how
  many steps away it is. Trust that list; do not re-count the lane string yourself.

JUMPING
- jump(w) applied at step S keeps the player airborne for the cells arriving at
  steps S, S+1, ... S+w-1. The player lands at step S+w, which must be a 0 cell.
- So an obstacle listed as "width w, arrives in j steps" is cleared by
  { "atStep": currentStep + j, "width": w }.
- w must equal the obstacle's listed width exactly.
- Obstacles are always separated by at least 4 empty cells, so every lane is clearable.
- Standing on a 1 while not airborne ends the game.

YOUR TASK
Emit exactly one action for EVERY obstacle in the provided list, in order. Missing one
kills the player.

Worked example - if currentStep is 40 and the list is
  - width 2, arrives in 3 steps
  - width 1, arrives in 9 steps
then the answer is
  {"reasoning": "w2 at +3, w1 at +9",
   "actions": [{"atStep": 43, "width": 2}, {"atStep": 49, "width": 1}]}

Reply with JSON only, in exactly this shape:
{"reasoning": "<one short line naming the runs you found>",
 "actions": [{"atStep": <integer>, "width": <1|2|3>}]}`;

// Run-length parsing is deterministic, so we do it here rather than asking a small
// model to count characters - that is where gpt-4o-mini reliably goes wrong.
function findObstacles(lane, playerIndex) {
  const out = [];
  for (let i = 0; i < lane.length; i++) {
    if (lane[i] !== "1") continue;
    let w = 0;
    while (i + w < lane.length && lane[i + w] === "1") w++;
    const stepsAway = i - playerIndex;
    if (stepsAway >= 2) out.push({ width: w, stepsAway });
    i += w - 1;
  }
  return out;
}

function parsePlan(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Some models wrap JSON in prose or a fenced block; salvage the outer object.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
    raw = JSON.parse(m[0]);
  }
  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .map((a) => ({ atStep: Number(a?.atStep), width: Number(a?.width) }))
    .filter((a) => Number.isInteger(a.atStep) && Number.isInteger(a.width)
                && a.width >= 1 && a.width <= 3);
  return { reasoning: String(raw.reasoning ?? ""), actions };
}

function buildUserMessage(obs) {
  const list = findObstacles(obs.lane, obs.playerIndex);
  const lines = list.length
    ? list.map((o) => `  - width ${o.width}, arrives in ${o.stepsAway} steps`).join("\n")
    : "  (none)";
  return `currentStep: ${obs.currentStep}\nlane: "${obs.lane}"\n` +
         `airborne: ${obs.airborne}\nobstacles:\n${lines}`;
}

async function decide(obs, signal) {
  if (!LLM_KEY) throw new Error("LLM_API_KEY is not set (put it in .env)");
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserMessage(obs) },
      ],
      // LiteLLM's Bedrock route answers `{}` when json_object mode is requested,
      // so we rely on the prompt plus parsePlan's salvage there instead.
      ...(MODEL.startsWith("bedrock/") ? {} : { response_format: { type: "json_object" } }),
      temperature: 0,
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`no content in response: ${JSON.stringify(data).slice(0, 300)}`);
  return parsePlan(text);
}

const ACT_SYSTEM = `You are the decision policy inside an agent that plays a
side-scrolling obstacle game. You are called once per obstacle, not every frame.

You receive a compact game state. The grid is discrete: there is no velocity, all
obstacles are height 1, and \`nearestObstacle.distance\` is how many steps until it
reaches the player. \`nearestObstacle.width\` is 1, 2 or 3.

You are asked ONCE per obstacle, deliberately early. You cannot defer: there is no
later call for this obstacle, and by the time it is close a jump would arrive too
late to clear it. Deciding "wait" while an obstacle is in view means the player runs
straight into it.

The agent handles the TIMING of the jump. You decide only whether to jump and how
wide. Do not reason about how many steps or milliseconds remain - that is not your job.

Decide ONE action:
- "jump" whenever nearestObstacle is present. Set "width" to that obstacle's width.
- "wait" only when nearestObstacle is null.

Reply with JSON only, and keep "reason" to at most six words - a long reason costs
generation time, and the obstacle is moving while you write it:
{"action":"jump"|"wait","width":<1|2|3>,"reason":"<=6 words"}`;

function parseAction(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
    raw = JSON.parse(m[0]);
  }
  // Shape only. The client validates against its own allowedActions and ranges.
  return { action: raw.action, width: raw.width, reason: raw.reason };
}

async function act(state, signal) {
  if (!LLM_KEY) throw new Error("LLM_API_KEY is not set (put it in .env)");
  const ob = state.nearestObstacle;
  const user = ob
    ? `step: ${state.game.step}\nspeed: ${state.game.speed}ms/step\n` +
      `grounded: ${state.dino.isGrounded}\n` +
      `nearestObstacle: width ${ob.width}, ${ob.distance} steps away\n` +
      `allowedActions: ${state.allowedActions.join(", ")}`
    : `step: ${state.game.step}\nno obstacle in view\n` +
      `allowedActions: ${state.allowedActions.join(", ")}`;

  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: ACT_SYSTEM }, { role: "user", content: user }],
      ...(MODEL.startsWith("bedrock/") ? {} : { response_format: { type: "json_object" } }),
      temperature: 0,
      max_tokens: 60,
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("no content in response");
  return parseAction(text);
}

const PLAN_SYSTEM = `You are the decision policy inside an agent that plays a
side-scrolling obstacle game. You are given every obstacle currently visible and
must return one action for EACH of them in a single reply.

The grid is discrete. Each obstacle lists its width (1, 2 or 3) and how many steps
away it is. An obstacle "arrives in j steps" is cleared by
{"atStep": currentStep + j, "width": <that obstacle's width>}.

Missing an obstacle kills the player. Emit one action per obstacle, in order.
Reply with JSON only, keeping "reason" to at most eight words:
{"reason":"<=8 words","actions":[{"atStep":<int>,"width":<1|2|3>}]}`;

async function plan(state, signal) {
  if (!LLM_KEY) throw new Error("LLM_API_KEY is not set (put it in .env)");
  const list = (state.obstacles ?? []);
  const lines = list.length
    ? list.map((o) => `  - width ${o.width}, arrives in ${o.distance} steps`).join("\n")
    : "  (none)";
  const user = `currentStep: ${state.game.step}\nspeed: ${state.game.speed}ms/step\n` +
               `obstacles:\n${lines}`;

  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: PLAN_SYSTEM }, { role: "user", content: user }],
      ...(MODEL.startsWith("bedrock/") ? {} : { response_format: { type: "json_object" } }),
      temperature: 0,
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("no content in response");
  const parsed = parsePlan(text);
  return { reason: parsed.reasoning, actions: parsed.actions };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/decide") {
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());   // client hit Abort -> drop the LLM call
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const plan = await decide(JSON.parse(Buffer.concat(chunks).toString()), ac.signal);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(plan));
    } catch (err) {
      if (ac.signal.aborted) { res.destroy(); return; }
      console.error("[decide]", err.message);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err.message ?? err));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/plan") {
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const out = await plan(JSON.parse(Buffer.concat(chunks).toString()), ac.signal);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (err) {
      if (ac.signal.aborted) { res.destroy(); return; }
      console.error("[plan]", err.message);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err.message ?? err));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/act") {
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const decision = await act(JSON.parse(Buffer.concat(chunks).toString()), ac.signal);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(decision));
    } catch (err) {
      if (ac.signal.aborted) { res.destroy(); return; }
      console.error("[act]", err.message);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err.message ?? err));
    }
    return;
  }

  const rel = req.url === "/" ? "index.html" : decodeURIComponent(req.url).slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}  (model: ${MODEL})`));
