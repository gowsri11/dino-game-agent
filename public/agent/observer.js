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
  for (let i = PLAYER_COL + 1; i < LANE_LEN; i++) {
    const kind = g.lane[i];
    if (kind === EMPTY) continue;
    let width = 0;
    while (i + width < LANE_LEN && g.lane[i + width] === kind) width++;
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
