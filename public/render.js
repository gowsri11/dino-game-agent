import { LANE_LEN, LANE_WIDTH, PLAYER_COL } from "./engine.js";

export const CELL = 40;
const ROWS_H = CELL * 5;
const GROUND_Y = CELL * 4;      // top of the ground row
const AIR_Y = CELL * 2;

export function setupCanvas(canvas) {
  canvas.width = LANE_WIDTH * CELL;
  canvas.height = ROWS_H;
  return canvas.getContext("2d");
}

// alpha = fraction of the way from the last logical step to the next one.
export function draw(ctx, g, alpha, prevAirborne = false) {
  const w = LANE_WIDTH * CELL;
  ctx.clearRect(0, 0, w, ROWS_H);

  ctx.fillStyle = "#f7f7f7";
  ctx.fillRect(0, 0, w, ROWS_H);

  ctx.strokeStyle = "#bbb";
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + CELL + 0.5);
  ctx.lineTo(w, GROUND_Y + CELL + 0.5);
  ctx.stroke();

  // One polygon per run of 1s, so only the run's outer edges slope: a width-1
  // obstacle is a peak, wider ones are plateaus with sloped ends.
  const SLOPE = CELL * 0.3;
  ctx.fillStyle = "#2f4858";
  for (let i = 0; i < LANE_LEN; i++) {
    if (g.lane[i] !== 1) continue;
    let w = 0;
    while (i + w < LANE_LEN && g.lane[i + w] === 1) w++;

    const x0 = (i - alpha) * CELL + 1;
    const x1 = (i + w - alpha) * CELL - 1;
    const top = GROUND_Y + 1;
    const bottom = GROUND_Y + CELL;

    ctx.beginPath();
    ctx.moveTo(x0, bottom);
    ctx.lineTo(x0 + SLOPE, top);
    ctx.lineTo(x1 - SLOPE, top);
    ctx.lineTo(x1, bottom);
    ctx.closePath();
    ctx.fill();

    i += w - 1;
  }

  // Rise fast, drop late. Collision is unchanged - this only stretches the
  // apparent hang time and keeps the sprite clear of the obstacle it just passed
  // until that obstacle has slid well past.
  const airborne = g.airborneNow;
  const from = prevAirborne ? AIR_Y : GROUND_Y;
  const to = airborne ? AIR_Y : GROUND_Y;
  const rising = to < from;
  const t = rising ? Math.min(1, alpha / 0.45)
                   : Math.max(0, (alpha - 0.45) / 0.55);
  const ease = t * t * (3 - 2 * t);
  const y = from + (to - from) * ease;

  ctx.font = `${CELL - 4}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = g.alive ? 1 : 0.45;
  ctx.fillText("\u{1F996}", PLAYER_COL * CELL + CELL / 2, y + CELL / 2);
  ctx.globalAlpha = 1;
}
