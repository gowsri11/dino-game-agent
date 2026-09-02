import { LANE_LEN, LANE_WIDTH, PLAYER_COL, LOW, HIGH, EMPTY, POSE } from "./engine.js";

export const CELL = 40;
const ROWS_H = CELL * 5;
const GROUND_Y = CELL * 3.5;          // top of a standing player
const FLOOR_Y = GROUND_Y + CELL;      // the ground line itself
const AIR_TOP = GROUND_Y - CELL * 1.4;

// Geometry chosen so the rules are visually true: a high obstacle overlaps a
// standing player and a jumping one, but passes clear over a crouch.
const HIGH_TOP = GROUND_Y - CELL * 0.6;
const DUCK_TOP = GROUND_Y + CELL * 0.45;

const COLOR = { [LOW]: "#2f4858", [HIGH]: "#b4531f" };
const SLOPE = CELL * 0.3;

export function setupCanvas(canvas) {
  canvas.width = LANE_WIDTH * CELL;
  canvas.height = ROWS_H;
  return canvas.getContext("2d");
}

// One polygon per run of like cells, so only a run's outer edges slope: a
// width-1 obstacle is a peak, wider ones are plateaus with sloped ends.
function drawRun(ctx, kind, i, w, alpha) {
  const x0 = (i - alpha) * CELL + 1;
  const x1 = (i + w - alpha) * CELL - 1;
  ctx.fillStyle = COLOR[kind];

  if (kind === LOW) {
    ctx.beginPath();
    ctx.moveTo(x0, FLOOR_Y);
    ctx.lineTo(x0 + SLOPE, GROUND_Y + 1);
    ctx.lineTo(x1 - SLOPE, GROUND_Y + 1);
    ctx.lineTo(x1, FLOOR_Y);
    ctx.closePath();
    ctx.fill();
    return;
  }
  // High obstacles hang in the air, so they taper at both top and bottom.
  const mid = HIGH_TOP + CELL / 2;
  ctx.beginPath();
  ctx.moveTo(x0, mid);
  ctx.lineTo(x0 + SLOPE, HIGH_TOP);
  ctx.lineTo(x1 - SLOPE, HIGH_TOP);
  ctx.lineTo(x1, mid);
  ctx.lineTo(x1 - SLOPE, HIGH_TOP + CELL);
  ctx.lineTo(x0 + SLOPE, HIGH_TOP + CELL);
  ctx.closePath();
  ctx.fill();
}

// alpha = fraction of the way from the last logical step to the next one.
export function draw(ctx, g, alpha, prevPose = POSE.STAND) {
  const w = LANE_WIDTH * CELL;
  ctx.clearRect(0, 0, w, ROWS_H);
  ctx.fillStyle = "#f7f7f7";
  ctx.fillRect(0, 0, w, ROWS_H);

  ctx.strokeStyle = "#bbb";
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y + 0.5);
  ctx.lineTo(w, FLOOR_Y + 0.5);
  ctx.stroke();

  for (let i = 0; i < LANE_LEN; i++) {
    const kind = g.lane[i];
    if (kind === EMPTY) continue;
    let run = 0;
    while (i + run < LANE_LEN && g.lane[i + run] === kind) run++;
    drawRun(ctx, kind, i, run, alpha);
    i += run - 1;
  }

  drawPlayer(ctx, g, alpha, prevPose);
}

const topFor = (pose) =>
  pose === POSE.AIR ? AIR_TOP : pose === POSE.DUCK ? DUCK_TOP : GROUND_Y;

function drawPlayer(ctx, g, alpha, prevPose) {
  // Rise fast, drop late. Collision is unchanged - this only stretches the
  // apparent hang time and keeps the sprite clear of the obstacle it just passed.
  const pose = g.poseNow;
  const from = topFor(prevPose);
  const to = topFor(pose);
  const rising = to < from;
  const t = rising ? Math.min(1, alpha / 0.45) : Math.max(0, (alpha - 0.45) / 0.55);
  const ease = t * t * (3 - 2 * t);
  const y = from + (to - from) * ease;

  const ducking = pose === POSE.DUCK;
  const size = ducking ? CELL * 0.55 : CELL - 4;
  ctx.font = `${size}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = g.alive ? 1 : 0.45;
  ctx.fillText("\u{1F996}",
    PLAYER_COL * CELL + CELL / 2,
    y + (ducking ? (FLOOR_Y - DUCK_TOP) / 2 : CELL / 2));
  ctx.globalAlpha = 1;
}
