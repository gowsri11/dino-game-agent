import { LANE_LEN, LANE_WIDTH, PLAYER_COL, LOW, HIGH, EMPTY, POSE, difficulty }
  from "./engine.js";

export const CELL = 44;
const ROWS_H = CELL * 7.5;
const FLOOR_Y = CELL * 6;             // the ground line
const GROUND_Y = FLOOR_Y - CELL;      // top of a standing player

// Geometry chosen so the rules are visually true: a high obstacle overlaps a
// standing player and a jumping one, but passes clear over a crouch.
const AIR_TOP = GROUND_Y - CELL * 1.4;
const HIGH_TOP = GROUND_Y - CELL * 0.6;
const DUCK_TOP = GROUND_Y + CELL * 0.45;
const SLOPE = CELL * 0.3;

// Half the sprite's visible width, in cells. The obstacle arriving next step is
// drawn sliding from cell PLAYER_COL+1 toward PLAYER_COL, so its leading edge
// first touches the sprite at this fraction of the step. Input timing is derived
// from it rather than guessed, so "too late" means the same thing on screen as
// it does in the rules.
export const SPRITE_HALF = 0.34;
export const CONTACT_ALPHA = Math.max(0, 0.5 - SPRITE_HALF);

// Two palettes, blended by the difficulty curve, so the world darkens as the
// game gets harder rather than on a timer of its own.
const DAY = {
  skyTop: "#79c2ff", skyBottom: "#d9f0ff", hillFar: "#a9cfd8", hillNear: "#7fb3c4",
  earth: "#d9c9a3", earthLine: "#b9a880", cloud: "#ffffff",
  low: "#2f7d4f", lowDark: "#1e5b38", high: "#e0651c", highDark: "#a8430c",
  text: "#20303c", shadow: "rgba(0,0,0,0.18)",
};
const NIGHT = {
  skyTop: "#0d1430", skyBottom: "#31406e", hillFar: "#1d2b4a", hillNear: "#152039",
  earth: "#2b2f42", earthLine: "#1b1f2e", cloud: "#8fa3c8",
  low: "#37b978", lowDark: "#1c6b45", high: "#ff8a3d", highDark: "#b04f14",
  text: "#dbe6f5", shadow: "rgba(0,0,0,0.45)",
};

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [r1, g1, b1] = hex(a), [r2, g2, b2] = hex(b);
  return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},` +
         `${Math.round(b1 + (b2 - b1) * t)})`;
};
function paletteFor(step) {
  const t = difficulty(step);
  const out = {};
  for (const k of Object.keys(DAY)) {
    out[k] = k === "shadow" ? (t > 0.5 ? NIGHT.shadow : DAY.shadow) : mix(DAY[k], NIGHT[k], t);
  }
  return out;
}

export function setupCanvas(canvas) {
  canvas.width = LANE_WIDTH * CELL;
  canvas.height = ROWS_H;
  return canvas.getContext("2d");
}

function drawSky(ctx, p, w) {
  const g = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  g.addColorStop(0, p.skyTop);
  g.addColorStop(1, p.skyBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, ROWS_H);
}

// Parallax: layers further away scroll slower, which is what sells the motion
// on a lane that is otherwise a flat array of cells.
function drawClouds(ctx, p, w, scroll) {
  ctx.fillStyle = p.cloud;
  ctx.globalAlpha = 0.75;
  for (let i = 0; i < 6; i++) {
    const span = w + 260;
    const x = ((i * 173 + 40) - scroll * CELL * 0.08) % span;
    const cx = x < -130 ? x + span : x;
    const cy = 26 + ((i * 37) % 46);
    const r = 13 + (i % 3) * 5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.9, cy + 4, r * 0.75, 0, Math.PI * 2);
    ctx.arc(cx - r * 0.9, cy + 5, r * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHills(ctx, color, w, scroll, speed, height, step) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  for (let x = 0; x <= w; x += 8) {
    const t = (x + scroll * CELL * speed) / step;
    ctx.lineTo(x, FLOOR_Y - height * (0.55 + 0.45 * Math.sin(t) * Math.cos(t * 0.37)));
  }
  ctx.lineTo(w, FLOOR_Y);
  ctx.closePath();
  ctx.fill();
}

function drawGround(ctx, p, w, scroll) {
  ctx.fillStyle = p.earth;
  ctx.fillRect(0, FLOOR_Y, w, ROWS_H - FLOOR_Y);
  ctx.strokeStyle = p.earthLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y + 1);
  ctx.lineTo(w, FLOOR_Y + 1);
  ctx.stroke();

  // Dashes on the floor move at full speed, giving the eye something to track.
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = -1; i < LANE_WIDTH + 1; i++) {
    const x = (i - (scroll % 1)) * CELL + (i * 17 % 11);
    ctx.moveTo(x, FLOOR_Y + 14 + (i % 3) * 9);
    ctx.lineTo(x + 12, FLOOR_Y + 14 + (i % 3) * 9);
  }
  ctx.stroke();
}

function drawRun(ctx, p, kind, i, w, alpha) {
  const x0 = (i - alpha) * CELL + 1;
  const x1 = (i + w - alpha) * CELL - 1;
  const light = kind === LOW ? p.low : p.high;
  const dark = kind === LOW ? p.lowDark : p.highDark;

  if (kind === LOW) {
    const g = ctx.createLinearGradient(0, GROUND_Y, 0, FLOOR_Y);
    g.addColorStop(0, light);
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, FLOOR_Y);
    ctx.lineTo(x0 + SLOPE, GROUND_Y + 1);
    ctx.lineTo(x1 - SLOPE, GROUND_Y + 1);
    ctx.lineTo(x1, FLOOR_Y);
    ctx.closePath();
    ctx.fill();
    return;
  }
  const mid = HIGH_TOP + CELL / 2;
  const g = ctx.createLinearGradient(0, HIGH_TOP, 0, HIGH_TOP + CELL);
  g.addColorStop(0, light);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
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

const topFor = (pose) =>
  pose === POSE.AIR ? AIR_TOP : pose === POSE.DUCK ? DUCK_TOP : GROUND_Y;

// Extra altitude on top of the clearance height, in proportion to the jump the
// player committed to: a tap hops, three taps arc. Presentation only - collision
// is "airborne clears low" regardless of height. Making height mechanical would
// mean tall obstacles, and "jump higher" is a size distinction, which needs
// timing margin to express and collapses (see ROADMAP.md). The verb is duck.
const ARC_PER_CELL = CELL * 0.45;
function arcLift(g, alpha) {
  if (g.poseNow !== POSE.AIR || !g.airSpan) return 0;
  const done = g.airSpan - g.airCells;          // cells already spent aloft
  const p = Math.min(1, Math.max(0, (done + alpha) / g.airSpan));
  const extra = Math.max(0, g.airSpan - 2) * ARC_PER_CELL;
  return extra * 4 * p * (1 - p);               // parabola, peaking mid-jump
}

function drawPlayer(ctx, p, g, alpha, prevPose, pulse, fx) {
  // Rise fast, drop late. Collision is unchanged - this only stretches the
  // apparent hang time and keeps the sprite clear of the obstacle it just passed.
  const pose = g.poseNow;
  const from = topFor(prevPose);
  const to = topFor(pose);
  const rising = to < from;
  const t = rising ? Math.min(1, alpha / 0.45) : Math.max(0, (alpha - 0.45) / 0.55);
  const ease = t * t * (3 - 2 * t);
  // The arc rides on top of the clearance height, so the sprite never dips back
  // toward an obstacle it is still passing over.
  // A mid-air tap extends the jump but barely moved the sprite, so the extra tap
  // registered as nothing. A short kick upward makes it land.
  const boost = fx.boost ?? 0;
  const y = from + (to - from) * ease - arcLift(g, alpha) - boost * CELL * 0.34;
  const cx = PLAYER_COL * CELL + CELL / 2;

  // Shadow shrinks with height, which reads as altitude without a second sprite.
  const lift = (FLOOR_Y - CELL - y) / (CELL * 1.4);
  ctx.fillStyle = p.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, FLOOR_Y + 3, CELL * (0.42 - lift * 0.16), CELL * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();

  if (pulse > 0) {
    ctx.strokeStyle = `rgba(120,235,170,${pulse * 0.85})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, y + CELL / 2, CELL * (0.5 + (1 - pulse) * 0.8), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (boost > 0) {
    // A puff under the feet, so the kick has a cause.
    ctx.fillStyle = `rgba(255,255,255,${boost * 0.7})`;
    for (const dx of [-9, 0, 9]) {
      ctx.beginPath();
      ctx.arc(cx + dx * (1.4 - boost), y + CELL * 1.05 + (1 - boost) * 8,
              4 + (1 - boost) * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const ducking = pose === POSE.DUCK;
  const cy = y + (ducking ? (FLOOR_Y - DUCK_TOP) / 2 : CELL / 2);

  // The sprite is light green and so is the daytime sky and hills, which left it
  // hard to pick out. A dark halo separates it from whatever is behind, and works
  // against the night palette too.
  ctx.font = `${ducking ? CELL * 0.55 : CELL - 4}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = g.alive ? 1 : 0.5;
  // Emoji ignore fillStyle, so colour has to come from a canvas filter and the
  // outline from shadow passes. Darkening the sprite is what actually separates
  // it from a bright sky; the halo alone was not enough.
  ctx.save();
  ctx.filter = "brightness(0.62) saturate(1.5) contrast(1.25)";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  for (const blur of [9, 6, 3]) {
    ctx.shadowBlur = blur;
    ctx.fillText("\u{1F996}", cx, cy);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawOverlay(ctx, p, w, status, g) {
  if (status !== "ready" && status !== "over" && status !== "arming") return;
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(0, 0, w, ROWS_H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";

  const title = status === "over" ? `score ${g.score}`
              : status === "arming" ? "agent is thinking…" : "Obstacle Runner";
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.fillText(title, w / 2, ROWS_H / 2 - 10);

  if (status !== "arming") {
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillStyle = "#cfe6ff";
    ctx.fillText(status === "over" ? "press SPACE to play again" : "press SPACE to start",
      w / 2, ROWS_H / 2 + 20);
  }
}

// alpha = fraction of the way from the last logical step to the next one.
// fx carries decaying 0..1 feedback values plus the run status, so the renderer
// owns the look and main.js only says what happened and when.
export function draw(ctx, g, alpha, prevPose = POSE.STAND, fx = {}) {
  const w = LANE_WIDTH * CELL;
  const p = paletteFor(g.step);
  const scroll = g.step + alpha;
  const shake = fx.shake ?? 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSky(ctx, p, w);
  if (shake > 0) {
    const mag = shake * shake * 8;
    ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    ctx.fillStyle = `rgba(220,40,40,${shake * 0.25})`;
    ctx.fillRect(-20, -20, w + 40, ROWS_H + 40);
  }

  drawClouds(ctx, p, w, scroll);
  drawHills(ctx, p.hillFar, w, scroll, 0.12, CELL * 1.5, 90);
  drawHills(ctx, p.hillNear, w, scroll, 0.28, CELL * 0.9, 55);
  drawGround(ctx, p, w, scroll);

  for (let i = 0; i < LANE_LEN; i++) {
    const kind = g.lane[i];
    if (kind === EMPTY) continue;
    let run = 0;
    while (i + run < LANE_LEN && g.lane[i + run] === kind) run++;
    drawRun(ctx, p, kind, i, run, alpha);
    i += run - 1;
  }

  drawPlayer(ctx, p, g, alpha, prevPose, fx.pulse ?? 0, fx);
  drawOverlay(ctx, p, w, fx.status, g);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
