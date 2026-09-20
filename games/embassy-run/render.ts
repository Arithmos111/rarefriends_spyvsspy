/**
 * Embassy renderer.
 *
 * Custom renderer, which FriendSDK explicitly allows, because the shipped GameWorld draws a
 * single local avatar and this game shows up to four agents plus traps, drops and doorways
 * in one room. The projection constants match the SDK's shallow isometric so the embassy
 * sits in the same visual language as the Rare Friends worlds, and the Friend sprites use
 * the canonical routine: 5x pixels in an 80x80 box, white one-pixel halo, black mask,
 * clipped, never rotated, stretched or recoloured.
 */
import { spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import {
  DOOR_HALF_WIDTH, FURNITURE_FOOTPRINT, MISSION_ITEM_LABELS, ROOM_H, ROOM_W,
  type Direction, type FurnitureType, type MatchSnapshot, type RoomActor,
} from "./shared/protocol.ts";
import { EXIT_RADIUS, EXIT_X, EXIT_Y } from "./shared/mansion.ts";

export const VIEW_W = 960;
export const VIEW_H = 640;

/**
 * Same isometric family as the SDK's world projection, opened up slightly (B) and scaled (S)
 * so one room fills the 960x640 container instead of sitting in a thin band. OFF re-centres
 * the diamond horizontally, because the room is wider than it is deep.
 */
const A = 0.8660254038;
const B = 0.38;
const S = 1.14;
const AX = A * S;
const BY = B * S;
const CX = 480;
const CY = 160;
const OFF = AX * (ROOM_W - ROOM_H) / 2;

export const INK = "#14180f";
export const FLOOR = "#cdd4bd";
export const FLOOR_LINE = "#b6bfa2";
export const WALL = "#9aa384";
export const WALL_DARK = "#7c866a";
export const VOID = "#181c12";
export const SIGNAL = "#CCFF00";
export const ALERT = "#E4572E";
export const PAPER = "#eef1e4";

export function project(x: number, y: number): [number, number] {
  return [CX + AX * (x - y) - OFF, CY + BY * (x + y)];
}

const depthOf = (x: number, y: number) => x + y;

type Sprites = Map<string, GenerationSprites | "loading" | "error">;

export type RenderInput = {
  snapshot: MatchSnapshot;
  /** Locally predicted position for the player's own agent, to hide relay latency. */
  selfX: number;
  selfY: number;
  sprites: Sprites;
  nearestFurnitureId: number | null;
  nearestDropId: number | null;
  reducedMotion: boolean;
  timeMs: number;
};

export function drawEmbassy(context: CanvasRenderingContext2D, input: RenderInput): void {
  const { snapshot, timeMs, reducedMotion } = input;
  context.save();
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, VIEW_W, VIEW_H);
  context.fillStyle = VOID;
  context.fillRect(0, 0, VIEW_W, VIEW_H);

  drawFloor(context);
  drawWalls(context, snapshot.doors);
  for (const direction of snapshot.doors) drawDoorway(context, direction, timeMs, reducedMotion);
  if (snapshot.exitHere) drawGate(context, snapshot.self.inventory.length, timeMs, reducedMotion);

  type Layer = { depth: number; draw: () => void };
  const layers: Layer[] = [];

  for (const drop of snapshot.drops) {
    layers.push({
      depth: depthOf(drop.x, drop.y) - 0.5,
      draw: () => drawDrop(context, drop.x, drop.y, drop.item, drop.id === input.nearestDropId, timeMs, reducedMotion),
    });
  }

  for (const piece of snapshot.furniture) {
    layers.push({
      depth: depthOf(piece.x, piece.y),
      draw: () => drawFurniture(context, piece, piece.id === input.nearestFurnitureId, timeMs, reducedMotion),
    });
  }

  const selfActor: RoomActor = { ...snapshot.self, x: input.selfX, y: input.selfY };
  for (const actor of [...snapshot.actors, selfActor]) {
    layers.push({
      depth: depthOf(actor.x, actor.y) + 0.25,
      draw: () => drawAgent(context, actor, actor.playerId === snapshot.self.playerId, input),
    });
  }

  layers.sort((left, right) => left.depth - right.depth);
  for (const layer of layers) layer.draw();

  context.restore();
}

function floorPath(context: CanvasRenderingContext2D): void {
  const corners: [number, number][] = [[0, 0], [ROOM_W, 0], [ROOM_W, ROOM_H], [0, ROOM_H]];
  context.beginPath();
  corners.forEach(([x, y], index) => {
    const [sx, sy] = project(x, y);
    if (index === 0) context.moveTo(sx, sy); else context.lineTo(sx, sy);
  });
  context.closePath();
}

function drawFloor(context: CanvasRenderingContext2D): void {
  floorPath(context);
  context.fillStyle = FLOOR;
  context.fill();
  context.save();
  context.clip();
  context.strokeStyle = FLOOR_LINE;
  context.lineWidth = 1;
  const step = 65;
  for (let x = 0; x <= ROOM_W; x += step) {
    const [ax, ay] = project(x, 0), [bx, by] = project(x, ROOM_H);
    context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke();
  }
  for (let y = 0; y <= ROOM_H; y += step) {
    const [ax, ay] = project(0, y), [bx, by] = project(ROOM_W, y);
    context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.stroke();
  }
  context.restore();
  floorPath(context);
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.stroke();
}

const WALL_HEIGHT = 105;

/** Back walls run along the two far edges; doorways there are drawn as gaps. */
function drawWalls(context: CanvasRenderingContext2D, doors: readonly Direction[]): void {
  const segments: { from: [number, number]; to: [number, number] }[] = [];
  const north = doors.includes("north");
  const west = doors.includes("west");
  const gap = DOOR_HALF_WIDTH;

  if (north) {
    segments.push({ from: [0, 0], to: [ROOM_W / 2 - gap, 0] });
    segments.push({ from: [ROOM_W / 2 + gap, 0], to: [ROOM_W, 0] });
  } else {
    segments.push({ from: [0, 0], to: [ROOM_W, 0] });
  }
  if (west) {
    segments.push({ from: [0, 0], to: [0, ROOM_H / 2 - gap] });
    segments.push({ from: [0, ROOM_H / 2 + gap], to: [0, ROOM_H] });
  } else {
    segments.push({ from: [0, 0], to: [0, ROOM_H] });
  }

  for (const segment of segments) {
    const [ax, ay] = project(...segment.from);
    const [bx, by] = project(...segment.to);
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.lineTo(bx, by - WALL_HEIGHT);
    context.lineTo(ax, ay - WALL_HEIGHT);
    context.closePath();
    context.fillStyle = segment.from[0] === 0 && segment.to[0] === 0 ? WALL_DARK : WALL;
    context.fill();
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.stroke();
  }
}

function doorAnchor(direction: Direction): [number, number] {
  if (direction === "north") return [ROOM_W / 2, 0];
  if (direction === "south") return [ROOM_W / 2, ROOM_H];
  if (direction === "west") return [0, ROOM_H / 2];
  return [ROOM_W, ROOM_H / 2];
}

function drawDoorway(context: CanvasRenderingContext2D, direction: Direction, timeMs: number, reducedMotion: boolean): void {
  const horizontal = direction === "north" || direction === "south";
  const [cx, cy] = doorAnchor(direction);
  const corners: [number, number][] = horizontal
    ? [[cx - DOOR_HALF_WIDTH, cy], [cx + DOOR_HALF_WIDTH, cy],
       [cx + DOOR_HALF_WIDTH, cy + (direction === "north" ? 26 : -26)], [cx - DOOR_HALF_WIDTH, cy + (direction === "north" ? 26 : -26)]]
    : [[cx, cy - DOOR_HALF_WIDTH], [cx, cy + DOOR_HALF_WIDTH],
       [cx + (direction === "west" ? 26 : -26), cy + DOOR_HALF_WIDTH], [cx + (direction === "west" ? 26 : -26), cy - DOOR_HALF_WIDTH]];

  context.beginPath();
  corners.forEach(([x, y], index) => {
    const [sx, sy] = project(x, y);
    if (index === 0) context.moveTo(sx, sy); else context.lineTo(sx, sy);
  });
  context.closePath();
  const pulse = reducedMotion ? 0.28 : 0.2 + 0.12 * (1 + Math.sin(timeMs / 420)) / 2;
  context.fillStyle = `rgba(204, 255, 0, ${pulse.toFixed(3)})`;
  context.fill();
  context.strokeStyle = SIGNAL;
  context.lineWidth = 2;
  context.stroke();
}

function drawGate(context: CanvasRenderingContext2D, carried: number, timeMs: number, reducedMotion: boolean): void {
  const [sx, sy] = project(EXIT_X, EXIT_Y);
  const ready = carried >= 4;
  context.save();
  context.beginPath();
  context.ellipse(sx, sy, EXIT_RADIUS * AX, EXIT_RADIUS * BY, 0, 0, Math.PI * 2);
  const pulse = reducedMotion ? 0.3 : 0.18 + 0.18 * (1 + Math.sin(timeMs / 300)) / 2;
  context.fillStyle = ready ? `rgba(204, 255, 0, ${(pulse + 0.25).toFixed(3)})` : `rgba(204, 255, 0, ${pulse.toFixed(3)})`;
  context.fill();
  context.strokeStyle = SIGNAL;
  context.setLineDash(ready ? [] : [7, 6]);
  context.lineWidth = ready ? 3 : 2;
  context.stroke();
  context.setLineDash([]);

  // Gate posts, so the exit reads as a way out rather than a floor decal.
  for (const offset of [-EXIT_RADIUS, EXIT_RADIUS]) {
    const [px, py] = project(EXIT_X + offset, EXIT_Y);
    context.beginPath();
    context.moveTo(px, py);
    context.lineTo(px, py - 58);
    context.lineWidth = 5;
    context.strokeStyle = INK;
    context.stroke();
    context.beginPath();
    context.arc(px, py - 62, 5, 0, Math.PI * 2);
    context.fillStyle = ready ? SIGNAL : WALL_DARK;
    context.fill();
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.stroke();
  }
  context.fillStyle = INK;
  context.font = "600 15px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText(ready ? "COURTYARD GATE — OPEN" : `COURTYARD GATE — ${carried}/4`, sx, sy - 76);
  context.restore();
}

/** Isometric prism whose base sits on the furniture's world anchor. */
function isoBox(context: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, height: number,
  top: string, left: string, right: string): void {
  const p = (dx: number, dy: number, lift = 0) => {
    const [sx, sy] = project(x + dx, y + dy);
    return [sx, sy - lift] as const;
  };
  const hw = w / 2, hd = d / 2;
  const faces: [readonly (readonly [number, number])[], string][] = [
    // Far-left face (+y plane), then near-right face (+x plane), then the lid on top.
    [[p(-hw, hd, 0), p(hw, hd, 0), p(hw, hd, height), p(-hw, hd, height)], left],
    [[p(hw, -hd, 0), p(hw, hd, 0), p(hw, hd, height), p(hw, -hd, height)], right],
    [[p(-hw, -hd, height), p(hw, -hd, height), p(hw, hd, height), p(-hw, hd, height)], top],
  ];
  for (const [points, fill] of faces) {
    context.beginPath();
    points.forEach(([px, py], index) => index === 0 ? context.moveTo(px, py) : context.lineTo(px, py));
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.stroke();
  }
}

const FURNITURE_HEIGHT: Record<FurnitureType, number> = {
  safe: 48, desk: 34, cabinet: 62, crate: 50, locker: 70, console: 40, planter: 54, painting: 52,
};

function drawFurniture(
  context: CanvasRenderingContext2D,
  piece: MatchSnapshot["furniture"][number],
  highlighted: boolean,
  timeMs: number,
  reducedMotion: boolean,
): void {
  const { w, h } = FURNITURE_FOOTPRINT[piece.type];
  const height = FURNITURE_HEIGHT[piece.type];
  const lid = piece.emptied ? "#aab394" : "#dfe4d2";
  const front = piece.emptied ? "#c3cbb0" : PAPER;
  isoBox(context, piece.x, piece.y, w, h, height, lid, "#959e80", front);

  const [sx, sy] = project(piece.x, piece.y);

  // A small face detail per type, so silhouettes stay distinguishable at phone size.
  context.save();
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  if (piece.type === "safe" || piece.type === "locker" || piece.type === "cabinet") {
    context.arc(sx + 6, sy - height / 2, 5, 0, Math.PI * 2);
  } else if (piece.type === "desk" || piece.type === "console") {
    context.moveTo(sx - 16, sy - height / 2); context.lineTo(sx + 16, sy - height / 2);
  } else if (piece.type === "crate") {
    context.moveTo(sx - 14, sy - height + 8); context.lineTo(sx + 14, sy - height / 3);
  } else if (piece.type === "planter") {
    context.moveTo(sx, sy - height); context.lineTo(sx, sy - height - 14);
    context.moveTo(sx, sy - height - 8); context.lineTo(sx - 9, sy - height - 16);
    context.moveTo(sx, sy - height - 8); context.lineTo(sx + 9, sy - height - 16);
  } else {
    context.rect(sx - 12, sy - height + 6, 24, height - 16);
  }
  context.stroke();
  context.restore();

  if (piece.emptied) {
    context.fillStyle = "rgba(20, 24, 15, 0.45)";
    context.font = "600 11px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("SEARCHED", sx, sy + 13);
  }

  if (piece.trap) {
    const pulse = reducedMotion ? 1 : 0.55 + 0.45 * (1 + Math.sin(timeMs / 220)) / 2;
    context.save();
    context.globalAlpha = pulse;
    context.fillStyle = piece.trapMine ? SIGNAL : ALERT;
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(sx, sy - height - 26);
    context.lineTo(sx + 11, sy - height - 8);
    context.lineTo(sx - 11, sy - height - 8);
    context.closePath();
    context.fill();
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = INK;
    context.font = "700 11px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("!", sx, sy - height - 11);
    context.restore();
  }

  if (highlighted) {
    context.save();
    context.strokeStyle = SIGNAL;
    context.lineWidth = 3;
    context.beginPath();
    context.ellipse(sx, sy, w * 0.62, h * 0.32, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

function drawDrop(
  context: CanvasRenderingContext2D, x: number, y: number, item: string,
  highlighted: boolean, timeMs: number, reducedMotion: boolean,
): void {
  const [sx, sy] = project(x, y);
  const bob = reducedMotion ? 0 : Math.sin(timeMs / 300) * 3;
  context.save();
  context.beginPath();
  context.ellipse(sx, sy, 15, 6, 0, 0, Math.PI * 2);
  context.fillStyle = "rgba(20,24,15,0.22)";
  context.fill();
  context.translate(0, bob);
  context.fillStyle = SIGNAL;
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  context.rect(sx - 12, sy - 26, 24, 17);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(sx - 4, sy - 26);
  context.lineTo(sx - 4, sy - 30);
  context.lineTo(sx + 4, sy - 30);
  context.lineTo(sx + 4, sy - 26);
  context.stroke();
  if (highlighted) {
    context.strokeStyle = SIGNAL;
    context.lineWidth = 3;
    context.beginPath();
    context.ellipse(sx, sy, 22, 10, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
  context.fillStyle = INK;
  context.font = "600 11px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText(MISSION_ITEM_LABELS[item as keyof typeof MISSION_ITEM_LABELS] ?? item, sx, sy + 17);
}

/**
 * Canonical Friend rendering: 5x square pixels, 80x80 box anchored at horizontal centre and
 * row 15, white one-pixel halo then the black mask, clipped to the box. Nothing is rotated,
 * scaled fractionally, recoloured or regenerated.
 */
function drawAgent(context: CanvasRenderingContext2D, actor: RoomActor, isSelf: boolean, input: RenderInput): void {
  const [x, y] = project(actor.x, actor.y);
  const left = Math.round(x) - 40;
  const top = Math.round(y) - 75;

  context.save();
  context.beginPath();
  context.ellipse(Math.round(x), Math.round(y), 17, 7, 0, 0, Math.PI * 2);
  context.fillStyle = "rgba(20,24,15,0.25)";
  context.fill();
  context.restore();

  const entry = input.sprites.get(actor.friendId);
  if (entry && entry !== "loading" && entry !== "error") {
    const frameIndex = input.reducedMotion ? 0 : Math.floor(input.timeMs / 110) % 8;
    const side = actor.facing === "left" || actor.facing === "right" ? actor.facing : "right";
    const rows = spriteFrame(entry, actor.facing, actor.walking, frameIndex, side).frame.rows;
    context.save();
    context.beginPath();
    context.rect(left, top, 80, 80);
    context.clip();
    if (actor.invulnerableMs > 0 && !input.reducedMotion) {
      context.globalAlpha = 0.45 + 0.55 * (1 + Math.sin(input.timeMs / 90)) / 2;
    }
    const pixels: [number, number][] = [];
    rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "#") pixels.push([px, py]); }));
    context.fillStyle = "#fff";
    for (const [px, py] of pixels) context.fillRect(left + px * 5 - 5, top + py * 5 - 5, 15, 15);
    context.fillStyle = "#000";
    for (const [px, py] of pixels) context.fillRect(left + px * 5, top + py * 5, 5, 5);
    context.restore();
  } else {
    context.save();
    context.strokeStyle = INK;
    context.setLineDash([4, 4]);
    context.lineWidth = 2;
    context.strokeRect(left + 22, top + 22, 36, 56);
    context.setLineDash([]);
    context.fillStyle = INK;
    context.font = "600 10px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(entry === "error" ? "ART?" : "···", Math.round(x), top + 54);
    context.restore();
  }

  const labelY = top - 6;
  context.save();
  context.textAlign = "center";
  context.font = "700 12px ui-monospace, monospace";
  const label = `${actor.codename}${actor.genesis ? " ◆" : ""}`;
  const width = context.measureText(label).width + 12;
  context.fillStyle = isSelf ? SIGNAL : "rgba(238,241,228,0.92)";
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(Math.round(x) - width / 2, labelY - 14, width, 18, 4);
  context.fill();
  context.stroke();
  context.fillStyle = INK;
  context.fillText(label, Math.round(x), labelY - 1);

  context.restore();

  // Injury pips sit by the feet, and only appear once an agent has been hit.
  if (actor.hp < 2 && actor.hp > 0) {
    context.save();
    for (let pip = 0; pip < 2; pip++) {
      context.beginPath();
      context.arc(Math.round(x) - 7 + pip * 14, Math.round(y) + 11, 4, 0, Math.PI * 2);
      context.fillStyle = pip < actor.hp ? ALERT : "rgba(238,241,228,0.85)";
      context.fill();
      context.strokeStyle = INK;
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }

  if (actor.busy) {
    const barWidth = 58;
    const barY = Math.round(y) + 16;
    context.save();
    context.fillStyle = "rgba(238,241,228,0.95)";
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(Math.round(x) - barWidth / 2, barY, barWidth, 9, 3);
    context.fill();
    context.stroke();
    context.fillStyle = SIGNAL;
    context.beginPath();
    context.roundRect(Math.round(x) - barWidth / 2 + 2, barY + 2, (barWidth - 4) * actor.busy.progress, 5, 2);
    context.fill();
    context.restore();
  }

  if (actor.stunnedMs > 0) {
    context.save();
    context.fillStyle = ALERT;
    context.font = "700 15px ui-monospace, monospace";
    context.textAlign = "center";
    const wobble = input.reducedMotion ? 0 : Math.sin(input.timeMs / 120) * 3;
    context.fillText("✶", Math.round(x) + wobble, top + 6);
    context.restore();
  }

  if (actor.attackingMs > 0) {
    context.save();
    context.strokeStyle = ALERT;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(Math.round(x), Math.round(y) - 26, 26, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

/** Screen point to world point, for tap-to-walk. Exact inverse of project(). */
export function unproject(screenX: number, screenY: number): [number, number] {
  const u = (screenX - CX + OFF) / AX;
  const v = (screenY - CY) / BY;
  return [(v + u) / 2, (v - u) / 2];
}
