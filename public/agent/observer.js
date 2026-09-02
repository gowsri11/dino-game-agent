// Converts engine internals into a compact, agent-readable state.
// Nothing here mutates the game.
import { PLAYER_COL, MAX_JUMP, LANE_LEN } from "../engine.js";

// This game is a discrete grid, not a physics sim: there is no velocityY, every
// obstacle is height 1, and positions are cell indices. `distance` is therefore
// in steps, which is also exactly how long until the obstacle reaches the player.
export function observeGameState(g) {
  // Every visible obstacle, nearest first. The agent needs more than the nearest:
  // once it has committed to one, the next may be only a few steps behind it,
  // which is less than a model round-trip.
  const obstacles = [];
  for (let i = PLAYER_COL + 1; i < LANE_LEN; i++) {
    if (g.lane[i] !== 1) continue;
    let width = 0;
    while (i + width < LANE_LEN && g.lane[i + width] === 1) width++;
    obstacles.push({
      width,
      height: 1,
      type: `w${width}`,
      distance: i - PLAYER_COL,             // steps until it is under the player
      arrivesAtStep: g.step + (i - PLAYER_COL),
    });
    i += width - 1;
  }
  const nearest = obstacles[0] ?? null;

  return {
    dino: {
      y: g.airborneNow ? 1 : 0,             // grid row, not pixels
      isGrounded: g.airCells === 0,
      airCells: g.airCells,
      canJump: g.airCells === 0 && g.groundCooldown === 0,
    },
    nearestObstacle: nearest,
    obstacles,
    game: {
      step: g.step,
      score: g.score,
      speed: g.stepMs,                      // ms per step; lower is faster
      isGameOver: !g.alive,
    },
    allowedActions: ["jump", "wait"],
    maxJumpWidth: MAX_JUMP,
  };
}
