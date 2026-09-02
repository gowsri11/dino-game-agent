// The tool layer: every game operation the agent is allowed to perform.
// The agent never touches the engine or the DOM directly, only these.
//
// Built from a context object supplied by main.js so this module stays free of
// module-level state and main.js keeps owning the loop.
import { observeGameState } from "./observer.js";

export function createTools(ctx) {
  const {
    getGame,        // () => live game state
    startGame,      // () => begin a fresh run in agent mode
    scheduleJump,   // (atStep, width) => queue a jump for a future step
    isRunning,      // () => whether the loop is stepping
    setFrozen,      // (bool) => hold the world still without ending the run
  } = ctx;

  const tools = {
    startGame() {
      startGame();
      return { started: true, step: getGame().step };
    },

    // Same operation as startGame here: a run always begins from a fresh lane.
    // Kept separate because the agent's intent differs and the events read better.
    resetGame() {
      startGame();
      return { reset: true };
    },

    // Hold the world still. Used for the opening decision: the first obstacle is
    // only ~4 steps out, which is less than one model round-trip.
    freeze() { setFrozen(true); return { frozen: true }; },
    unfreeze() { setFrozen(false); return { frozen: false }; },

    observeGameState() {
      return observeGameState(getGame());
    },

    // Preferred path: name the step the obstacle arrives and let the loop fire
    // the jump at the right moment, which is what makes LLM latency survivable.
    scheduleJump(atStep, width) {
      scheduleJump(atStep, width);
      return { scheduled: true, atStep, width };
    },

    async waitTicks(n = 1) {
      const target = getGame().step + n;
      while (isRunning() && !tools.isGameOver() && getGame().step < target) {
        await new Promise((r) => setTimeout(r, 8));
      }
      return { step: getGame().step };
    },

    async waitMs(ms) {
      await new Promise((r) => setTimeout(r, ms));
      return { step: getGame().step };
    },

    getScore() {
      return getGame().score;
    },

    isGameOver() {
      return !getGame().alive;
    },
  };

  return tools;
}
