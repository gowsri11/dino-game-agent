// Converts engine internals into a compact, agent-readable state.
// Nothing here mutates the game.
import { PLAYER_COL, MAX_JUMP, LANE_LEN, EMPTY, HIGH, POSE, poseOf } from "../engine.js";

// This game is a discrete grid, not a physics sim: there is no velocityY, every
// obstacle is one row tall, and positions are cell indices. `distance` is
// therefore in steps, which is also exactly how long until the obstacle lands.
// `requiredAction` is the whole decision: low obstacles are jumped, high ones
// are ducked, and standing still loses to either.
export function observeGameState(g) {
  const obstacles = [];
  // Scan from the very left, not from the player. Starting mid-lane can begin
  // inside an obstacle that is half past the player, and its trailing cell then
  // reads as a fresh narrow obstacle arriving a step later - a phantom that gets
  // acted on twice, extending one jump into an over-commitment.
  for (let i = 0; i < LANE_LEN; i++) {
    const kind = g.lane[i];
    if (kind === EMPTY) continue;
    let width = 0;
    while (i + width < LANE_LEN && g.lane[i + width] === kind) width++;
    // A run touching the right edge may still be arriving, so its leading cell
    // and true width are not known yet. Reporting it produces a phantom narrow
    // obstacle at a later arrival step, and acting on both that and the real one
    // extends a single jump into an over-commitment. It is fully visible next
    // step, with ~18 steps of runway still to spare.
    if (i + width >= LANE_LEN) break;
    if (i <= PLAYER_COL) { i += width - 1; continue; }   // arrived or already past
    const high = kind === HIGH;
    obstacles.push({
      kind: high ? "high" : "low",
      requiredAction: high ? "duck" : "jump",
      width,
      type: `${high ? "high" : "low"}-w${width}`,
      distance: i - PLAYER_COL,
      arrivesAtStep: g.step + (i - PLAYER_COL),
    });
    i += width - 1;
  }

  const pose = poseOf(g);
  return {
    dino: {
      pose,
      isGrounded: pose !== POSE.AIR,
      airCells: g.airCells,
      duckCells: g.duckCells,
      canAct: g.airCells === 0 && g.groundCooldown === 0,
    },
    nearestObstacle: obstacles[0] ?? null,
    obstacles,
    game: {
      step: g.step,
      score: g.score,
      speed: g.stepMs,                      // ms per step; lower is faster
      isGameOver: !g.alive,
    },
    allowedActions: ["jump", "duck", "wait"],
    maxJumpWidth: MAX_JUMP,
  };
}
