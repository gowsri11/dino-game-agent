# Obstacle Runner

Grid-based Chrome-dino-style game. Playable by a human or by a Claude agent.

## Run

```bash
npm install
cp .env.example .env      # only needed for agent mode
npm start                 # http://localhost:3000
npm test                  # engine tests, no API key needed
```

Human mode needs no credentials.

## Rules

- Lane of 20 cells; the player is fixed at index 2. The lane shifts one cell left per step.
- Obstacles are height 1, width 1/2/3, always separated by >= 4 empty cells. Each run
  of cells is drawn as one polygon with sloped outer edges — a width-1 obstacle is a
  peak, wider ones are plateaus. Collision stays whole-cell; the slope is cosmetic.
- **Space** = jump, applied on the keypress itself (not the next step boundary).
  Tap again mid-air to extend.
- Airtime is **width + 1** cells. The spare cell absorbs the fact that a press lands
  at an arbitrary point inside a cell, and lets liftoff happen a step before contact.
  So one tap covers 2 cells, two taps 3, three taps 4.
- Key auto-repeat is ignored; a press during the landing cooldown is buffered and
  replayed rather than dropped.
- Every tap lifts off on the keypress itself, so the jump is never visually delayed.
  A tap arriving more than `LATE_PRESS` (45%) into a step is too late for the cell
  already sliding onto the player: it still jumps, but forfeits protection against
  that one cell, so you clip it. Late taps look responsive and still lose.
- One forced grounded step between jumps, so mashing space does not grant flight.
- The sprite rises fast and drops late. That is presentation only — it stretches the
  apparent hang time and keeps the player clear of the obstacle it just passed,
  without touching collision.
- Landing on a `1` ends the game. Speed ramps from 260ms to 120ms per step.

## Seeds

The generator is seeded, so a run is reproducible. The seed box shows the current
run's seed and accepts one to replay; `share` copies a `?seed=` link. Same seed,
same lane - which is what makes a human score and an agent score comparable.

## Design

The world is a discrete state machine: one logical step = the lane advances exactly
one cell. Rendering runs on `requestAnimationFrame` and interpolates between steps.
There is no physics and no continuous collision detection — collision is one array
lookup at `lane[2]`.

`public/engine.js` is pure (no DOM, no timers), so the tests and any future headless
agent run the exact same code as the browser.

Step order, which the off-by-one behaviour depends on:

1. apply the action for this step
2. shift the lane, `step++`
3. record `airborneNow` (display truth for the cell now under the player)
4. if not airborne and `lane[2] === 1` → game over
5. decrement airborne cells; on landing set a one-step ground cooldown

`airCells` is the countdown and drops a step ahead of the cell it paid for, so the
renderer and any overlap check must read `airborneNow`, not `airCells > 0`.

## The agent

An `Agent` (`public/agent/`) owns a control loop that observes, decides and executes
through an explicit tool layer, emitting events as it goes. The LLM is only the
decision policy inside that loop.

- `observer.js` turns engine state into compact agent-readable state
- `tools.js` is the only way the agent touches the game
- `policies.js` holds the swappable decision policies
- `agent.js` owns the loop; `events.js` is a minimal event bus

Three policies, selectable in the UI:

| policy | calls | endpoint | notes |
|---|---|---|---|
| `llm-batch` | one per 5 steps, covering every visible obstacle | `POST /plan` | **best.** Each obstacle is covered by several successive plans, so a late response is dropped harmlessly and the next plan re-covers it |
| `llm` | one per obstacle | `POST /act` | no redundancy: a single late response loses that obstacle permanently |
| `heuristic` | none | - | pure code; also the automatic fallback for both LLM policies |

Measured over ~45s runs: batch survived past score 183 while *missing 11 actions*;
per-obstacle died at 37 having missed only 4. Redundancy, not accuracy, is what
makes an LLM usable in the loop - decisions were valid in every run (`policy_fallback: 0`).

A decision that arrives after its target step is deliberately **dropped**, not
executed late: jumping at an arbitrary moment is worse than missing quietly, and it
burns the landing cooldown needed for the next obstacle. Missed obstacles are not
marked handled, so they stay retryable.

### The original one-shot planner

Because the lane is discrete, an obstacle at index `2+j` arrives under the player in
exactly `j` steps. So the agent never says "jump now" — it returns absolute scheduled
actions:

```json
{ "actions": [{ "atStep": 47, "width": 2 }] }
```

The client lifts off at `atStep - 1`, one step before the obstacle arrives, which the
width+1 airtime pays for. The game keeps stepping while a call is in flight; as long
as the response lands before that, the play is frame-perfect regardless of latency. This is what makes a
~400ms model call usable in a 250ms-per-step game.

**Planner mode**: one call every 5 steps plans every obstacle currently visible,
rather than one call per step. Responses are merged by `atStep` and de-duplicated.

Agent mode freezes the world in an "arming" state until the first plan arrives —
the opening round-trip costs ~1.2s and the first obstacle lands at ~1.6s.

- **Abort** cancels the in-flight call (`AbortController`), clears the schedule, and
  lets the game run on until the player hits something.
- **Pause/Continue** freezes the step loop. Scheduled actions stay valid across a
  pause because the clock is step-indexed, not wall-clock.

`POST /decide` takes `{currentStep, lane, playerIndex, airborne}` and returns the plan.
Structured outputs (`output_config.format` + Zod) guarantee the JSON parses.

The browser is authoritative for game state; the server only plans. The API key never
reaches the client.

## Testing

`npm test` covers the generator invariants (width <= 3, gap >= 4), that `jump(w)`
clears width `w` both on time and a step early, that one tap cannot clear width 3,
that space-mashing cannot fly, and — most
importantly — that a reference planner following the exact rule stated in the system
prompt survives 2000 steps on 20 seeds. If the agent dies, that test is the way to
tell a model error from an engine error.
