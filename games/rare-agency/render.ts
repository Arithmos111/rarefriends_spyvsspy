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
  ATTACK_WINDUP_MS, DOOR_HALF_WIDTH, EFFECT_DURATION_MS, FURNITURE_FOOTPRINT, MISSION_ITEMS,
  PROP_SURFACES, ROOM_H, ROOM_PROPS, ROOM_W, type PropKind,
  carryableLabel, isDoorTrapId, isWallMounted, roomSignPlacement,
  type Carryable, type DecorType, type Direction, type EffectKind, type FurnitureType,
  type MatchSnapshot, type RoomActor, type RoomDecor, type RoomTrap,
} from "./shared/protocol.ts";
import { CACHE_SLOT, EXIT_RADIUS, EXIT_X, EXIT_Y } from "./shared/mansion.ts";

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

/**
 * A unit screen vector for the way an agent is facing.
 *
 * Facing is stored in world terms, and the room is drawn isometrically, so "right" is not
 * screen-right: world +x runs down and to the right, world +y down and to the left. Anything
 * drawn pointing the way an agent faces has to come through here.
 */
export function facingScreenDir(facing: RoomActor["facing"]): readonly [number, number] {
  const [wx, wy] = facing === "right" ? [1, 0]
    : facing === "left" ? [-1, 0]
      : facing === "down" ? [0, 1]
        : [0, -1];
  const sx = AX * (wx - wy);
  const sy = BY * (wx + wy);
  const length = Math.hypot(sx, sy) || 1;
  return [sx / length, sy / length];
}

type Sprites = Map<string, GenerationSprites | "loading" | "error">;

export type RenderInput = {
  snapshot: MatchSnapshot;
  /** Locally predicted position for the player's own agent, to hide relay latency. */
  selfX: number;
  selfY: number;
  sprites: Sprites;
  /** Static dressing for this room, rebuilt client-side from the map seed. */
  decor: readonly RoomDecor[];
  nearestFurnitureId: number | null;
  nearestDropId: number | null;
  /** Doorway the agent is standing close enough to trap. */
  nearestDoor: Direction | null;
  /** Trap detonations and landed blows currently running in this room. */
  effects: readonly ActiveEffect[];
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
  drawCacheStencil(context, snapshot.furniture);
  drawFloorDecor(context, input.decor);
  drawWalls(context, snapshot.doors);
  drawWallDecor(context, input.decor);
  // The name plate is drawn after the dressing, so a hanging can never cover it. Decor
  // anchors near the plate are also excluded when the map is generated; this is the belt to
  // that pair of braces.
  drawRoomSign(context, snapshot.roomName, snapshot.doors);
  for (const direction of snapshot.doors) {
    drawDoorway(context, direction, timeMs, reducedMotion, direction === input.nearestDoor);
  }
  if (snapshot.exitHere) drawGate(context, snapshot.self.inventory.length, timeMs, reducedMotion);

  // Doorway traps sit flat in the threshold, so they draw with the floor rather than sorted.
  for (const trap of snapshot.traps) {
    // The direction comes from the snapshot, not from the id: a doorway trap is keyed to the
    // opening, so its id names the other room's wall when you are standing on the far side.
    const direction = trap.direction;
    if (!direction || !snapshot.doors.includes(direction)) continue;
    const anchor = doorAnchorWorld(direction);
    drawTrapMarker(context, anchor.x, anchor.y, 6, trap, timeMs, reducedMotion);
  }

  // Hangings live on the wall plane, so they draw with the walls rather than being sorted
  // among the floor pieces. A trap on one is marked here too, for the same reason.
  const wallTraps = new Map(snapshot.traps.map(trap => [trap.targetId, trap]));
  for (const piece of snapshot.furniture) {
    if (!isWallMounted(piece.type)) continue;
    drawWallFurniture(context, piece, wallTraps.get(piece.id) ?? null,
      piece.id === input.nearestFurnitureId, timeMs, reducedMotion);
  }

  type Layer = { depth: number; draw: () => void };
  const layers: Layer[] = [];

  for (const drop of snapshot.drops) {
    layers.push({
      depth: depthOf(drop.x, drop.y) - 0.5,
      draw: () => drawDrop(context, drop.x, drop.y, drop.item, drop.id === input.nearestDropId, timeMs, reducedMotion),
    });
  }

  const trapByTarget = new Map(snapshot.traps.map(trap => [trap.targetId, trap]));
  for (const piece of snapshot.furniture) {
    if (isWallMounted(piece.type)) continue;
    const trap = trapByTarget.get(piece.id) ?? null;
    layers.push({
      depth: depthOf(piece.x, piece.y),
      draw: () => drawFurniture(context, piece, trap, piece.id === input.nearestFurnitureId,
        timeMs, reducedMotion, snapshot.roomIndex),
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

  for (const effect of input.effects) drawEffect(context, effect, reducedMotion);

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

/** A brass plate on the back wall naming the room, so the embassy reads as a building. */
/**
 * The room's name, bolted to the wall it hangs on.
 *
 * Drawn inside the wall's own plane rather than square to the screen: the plate is sheared to
 * the wall's rake and sized as a fraction of the wall's length, so it reads as a plaque fixed
 * to the plaster instead of a label floating in front of it. The text is sheared with it,
 * which is what sells the surface.
 */
function drawRoomSign(context: CanvasRenderingContext2D, name: string, doors: readonly Direction[]): void {
  const { onNorth, centre: midU, width: plateU } = roomSignPlacement(doors);
  const label = name.toUpperCase();

  // u runs along the wall in world units and v runs down the plaster in pixels. Each wall
  // gets the origin and direction that keep the lettering reading left to right.
  const [ox, oy] = onNorth ? project(0, 0) : project(0, ROOM_H);

  context.save();
  context.translate(ox, oy);
  context.transform(AX, onNorth ? BY : -BY, 0, 1, 0, 0);

  const height = 34;
  const top = -WALL_HEIGHT + 20;

  // Size the lettering to the plate rather than the plate to the lettering, so every room's
  // sign is the same size and sits in the same place.
  let size = 19;
  const fit = () => { context.font = `700 ${size}px ui-monospace, monospace`; };
  fit();
  while (size > 9 && context.measureText(label).width > plateU - 40) { size -= 1; fit(); }

  context.fillStyle = PAPER;
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  context.rect(midU - plateU / 2, top, plateU, height);
  context.fill();
  context.stroke();

  // An engraved border inset from the edge.
  context.strokeStyle = "rgba(20,24,15,0.35)";
  context.lineWidth = 1;
  context.strokeRect(midU - plateU / 2 + 5, top + 5, plateU - 10, height - 10);

  // Four fixing bolts, which is what sells it as a plate rather than a painted label.
  context.fillStyle = WALL_DARK;
  for (const cu of [midU - plateU / 2 + 11, midU + plateU / 2 - 11]) {
    for (const cv of [top + 9, top + height - 9]) {
      context.beginPath();
      context.arc(cu, cv, 2.2, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.fillStyle = INK;
  context.textAlign = "center";
  context.fillText(label, midU, top + height / 2 + size * 0.36);
  context.restore();
}

/**
 * A painted stencil on the floor under the cache.
 *
 * Every room has its cache in the same corner, and mission items are only ever hidden there.
 * Marking it in every room teaches that rule without a tutorial line: once you have seen the
 * stencil twice you know where to run in a room you have never entered.
 */
function drawCacheStencil(
  context: CanvasRenderingContext2D, furniture: MatchSnapshot["furniture"],
): void {
  const cache = furniture.find(piece => piece.slot === CACHE_SLOT);
  if (!cache) return;
  const [sx, sy] = project(cache.x, cache.y);
  context.save();
  // Sized to stay inside the floor: the cache sits in a corner, so a wide ring spills past
  // the room's edge and reads as a rendering fault.
  context.strokeStyle = "rgba(204,255,0,0.5)";
  context.lineWidth = 2;
  context.setLineDash([8, 6]);
  context.beginPath();
  context.ellipse(sx, sy + 4, 42 * AX, 42 * BY * 1.3, 0, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  // Corner ticks, so it reads as a marked bay rather than a puddle of light.
  context.strokeStyle = "rgba(204,255,0,0.62)";
  context.lineWidth = 2.5;
  for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const [cx, cy] = project(cache.x + ox * 36, cache.y + oy * 36);
    context.beginPath();
    context.moveTo(cx - ox * 8 * AX, cy - ox * 8 * BY);
    context.lineTo(cx, cy);
    context.lineTo(cx + oy * 8 * AX, cy - oy * 8 * BY);
    context.stroke();
  }
  context.restore();
}

/** Flat dressing that belongs under everything else. */
function drawFloorDecor(context: CanvasRenderingContext2D, decor: readonly RoomDecor[]): void {
  for (const piece of decor) {
    if (piece.type !== "rug") continue;
    const [sx, sy] = project(piece.x, piece.y);
    context.save();
    context.beginPath();
    context.ellipse(sx, sy, 92, 34, 0, 0, Math.PI * 2);
    context.fillStyle = piece.variant % 2 ? "#c2cbae" : "#c8d0b6";
    context.fill();
    context.strokeStyle = FLOOR_LINE;
    context.lineWidth = 3;
    context.stroke();
    context.beginPath();
    context.ellipse(sx, sy, 72, 25, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

/** Pictures, banners, clocks and flags hung on the two far walls. */
function drawWallDecor(context: CanvasRenderingContext2D, decor: readonly RoomDecor[]): void {
  for (const piece of decor) {
    if (piece.type === "rug" || piece.type === "lamp" || piece.type === "bookshelf") continue;
    const [sx, sy] = project(piece.x, piece.y);
    const top = sy - WALL_HEIGHT + 34;
    context.save();
    context.strokeStyle = INK;
    context.lineWidth = 2;
    if (piece.type === "portrait") {
      context.fillStyle = PAPER;
      context.fillRect(sx - 17, top, 34, 42);
      context.strokeRect(sx - 17, top, 34, 42);
      context.fillStyle = WALL_DARK;
      context.beginPath();
      context.arc(sx, top + 16, 7, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(sx - 10, top + 38);
      context.quadraticCurveTo(sx, top + 22, sx + 10, top + 38);
      context.fill();
    } else if (piece.type === "banner") {
      context.fillStyle = piece.variant % 2 ? SIGNAL : PAPER;
      context.beginPath();
      context.moveTo(sx - 14, top);
      context.lineTo(sx + 14, top);
      context.lineTo(sx + 14, top + 46);
      context.lineTo(sx, top + 36);
      context.lineTo(sx - 14, top + 46);
      context.closePath();
      context.fill();
      context.stroke();
    } else if (piece.type === "clock") {
      context.fillStyle = PAPER;
      context.beginPath();
      context.arc(sx, top + 18, 15, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(sx, top + 18);
      context.lineTo(sx, top + 8);
      context.moveTo(sx, top + 18);
      context.lineTo(sx + 8, top + 21);
      context.stroke();
    } else {
      // Flag on a short pole.
      context.beginPath();
      context.moveTo(sx - 14, top);
      context.lineTo(sx - 14, top + 46);
      context.stroke();
      context.fillStyle = piece.variant % 2 ? SIGNAL : "#b9c2a6";
      context.beginPath();
      context.moveTo(sx - 14, top + 3);
      context.lineTo(sx + 18, top + 11);
      context.lineTo(sx - 14, top + 22);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  }
}

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

export function doorAnchorWorld(direction: Direction): { x: number; y: number } {
  if (direction === "north") return { x: ROOM_W / 2, y: 0 };
  if (direction === "south") return { x: ROOM_W / 2, y: ROOM_H };
  if (direction === "west") return { x: 0, y: ROOM_H / 2 };
  return { x: ROOM_W, y: ROOM_H / 2 };
}

function drawDoorway(
  context: CanvasRenderingContext2D, direction: Direction, timeMs: number,
  reducedMotion: boolean, highlighted = false,
): void {
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
  context.lineWidth = highlighted ? 4 : 2;
  context.stroke();
  if (highlighted) {
    context.setLineDash([6, 5]);
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.stroke();
    context.setLineDash([]);
  }
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
/**
 * A box in the room's isometric projection.
 *
 * `base` lifts the bottom off the floor, which is what makes a table a table: a slab drawn
 * from the floor up hides its own legs, so tables and bench seats read as plinths.
 */
function isoBox(context: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, height: number,
  top: string, left: string, right: string, base = 0): void {
  const p = (dx: number, dy: number, lift = 0) => {
    const [sx, sy] = project(x + dx, y + dy);
    return [sx, sy - lift] as const;
  };
  const hw = w / 2, hd = d / 2;
  const faces: [readonly (readonly [number, number])[], string][] = [
    // Far-left face (+y plane), then near-right face (+x plane), then the lid on top.
    [[p(-hw, hd, base), p(hw, hd, base), p(hw, hd, height), p(-hw, hd, height)], left],
    [[p(hw, -hd, base), p(hw, hd, base), p(hw, hd, height), p(hw, -hd, height)], right],
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
  table: 32, bookcase: 74, barrel: 46, bench: 26,
  // Wall pieces: how far the hanging drops below the top of the wall.
  wallclock: 44, wallart: 52,
};

/** Shades shared by every carcass, dimmed once a piece has been turned out. */
function carcass(emptied: boolean) {
  return emptied
    ? { top: "#aab394", left: "#8d967a", right: "#c3cbb0" }
    : { top: "#dfe4d2", left: "#959e80", right: PAPER };
}

/**
 * A rectangle painted onto one of a box's two visible faces.
 *
 * `u` runs across the face (0 to 1) and `v` up it (0 at the floor, 1 at `height`), so drawer
 * fronts, shelves, vents and screens can be placed in the face's own terms rather than
 * reverse-engineered from screen coordinates.
 */
function facePanel(
  context: CanvasRenderingContext2D,
  x: number, y: number, w: number, d: number, height: number,
  face: "right" | "left",
  u0: number, u1: number, v0: number, v1: number,
  fill: string | null, stroke = INK, lineWidth = 2,
): void {
  const hw = w / 2, hd = d / 2;
  const at = (u: number, v: number) => {
    const [sx, sy] = face === "right"
      ? project(x + hw, y - hd + u * d)
      : project(x - hw + u * w, y + hd);
    return [sx, sy - v * height] as const;
  };
  const corners = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  context.beginPath();
  corners.forEach(([px, py], index) => index === 0 ? context.moveTo(px, py) : context.lineTo(px, py));
  context.closePath();
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
}

/** A short line across a face, for handles, shelf edges and vent slats. */
function faceLine(
  context: CanvasRenderingContext2D,
  x: number, y: number, w: number, d: number, height: number,
  face: "right" | "left",
  u0: number, u1: number, v: number, lineWidth = 2,
): void {
  facePanel(context, x, y, w, d, height, face, u0, u1, v, v, null, INK, lineWidth);
}

/** An upright leg, drawn as a thin box so it sits in the same projection as everything else. */
function leg(
  context: CanvasRenderingContext2D, x: number, y: number, height: number, shade: string,
): void {
  isoBox(context, x, y, 8, 8, height, shade, "#7c866a", shade);
}

/**
 * A small object standing on a piece of furniture.
 *
 * Chosen from the room's own list by the piece id, so it is stable, needs no wire traffic and
 * both sides agree. Props are what give a room its character: the same cabinet reads as a
 * records vault with a ledger on it and as a signals room with a radio set on it.
 */
function drawProp(
  context: CanvasRenderingContext2D, kind: PropKind, x: number, y: number, lift: number,
): void {
  const [sx, sy] = project(x, y);
  const baseY = sy - lift;
  context.save();
  context.strokeStyle = INK;
  context.lineWidth = 1.5;
  context.lineJoin = "round";

  switch (kind) {
    case "telephone": {
      context.fillStyle = "#2b3220";
      context.fillRect(sx - 10, baseY - 7, 20, 7);
      context.strokeRect(sx - 10, baseY - 7, 20, 7);
      context.beginPath();
      context.moveTo(sx - 11, baseY - 10);
      context.quadraticCurveTo(sx, baseY - 17, sx + 11, baseY - 10);
      context.lineWidth = 3.5;
      context.stroke();
      break;
    }
    case "papers": {
      context.fillStyle = PAPER;
      for (const [ox, oy, angle] of [[-5, 0, -0.16], [4, -2, 0.12]] as const) {
        context.save();
        context.translate(sx + ox, baseY + oy);
        context.rotate(angle);
        context.fillRect(-9, -11, 18, 11);
        context.strokeRect(-9, -11, 18, 11);
        context.restore();
      }
      break;
    }
    case "books": {
      const spines = ["#8d967a", PAPER, "#2b3220", "#8d967a"];
      spines.forEach((fill, index) => {
        const h = 13 + (index % 2) * 4;
        context.fillStyle = fill;
        context.fillRect(sx - 14 + index * 7, baseY - h, 6, h);
        context.strokeRect(sx - 14 + index * 7, baseY - h, 6, h);
      });
      break;
    }
    case "lamp": {
      context.fillStyle = "#2b3220";
      context.fillRect(sx - 2, baseY - 16, 4, 16);
      context.stroke();
      context.fillStyle = "#e8c547";
      context.beginPath();
      context.moveTo(sx - 11, baseY - 16);
      context.lineTo(sx + 11, baseY - 16);
      context.lineTo(sx + 7, baseY - 27);
      context.lineTo(sx - 7, baseY - 27);
      context.closePath();
      context.fill();
      context.stroke();
      break;
    }
    case "bottles": {
      [[-8, 1], [0, 1.15], [8, 0.9]].forEach(([ox, scale]) => {
        const h = 18 * scale;
        context.fillStyle = "#4f6b3a";
        context.beginPath();
        context.moveTo(sx + ox - 4, baseY);
        context.lineTo(sx + ox - 4, baseY - h * 0.55);
        context.lineTo(sx + ox - 1.5, baseY - h * 0.78);
        context.lineTo(sx + ox - 1.5, baseY - h);
        context.lineTo(sx + ox + 1.5, baseY - h);
        context.lineTo(sx + ox + 1.5, baseY - h * 0.78);
        context.lineTo(sx + ox + 4, baseY - h * 0.55);
        context.lineTo(sx + ox + 4, baseY);
        context.closePath();
        context.fill();
        context.stroke();
      });
      break;
    }
    case "radio": {
      context.fillStyle = "#2b3220";
      context.fillRect(sx - 14, baseY - 15, 28, 15);
      context.strokeRect(sx - 14, baseY - 15, 28, 15);
      context.fillStyle = SIGNAL;
      context.fillRect(sx - 10, baseY - 12, 11, 6);
      context.strokeStyle = INK;
      context.beginPath();
      context.arc(sx + 8, baseY - 8, 3, 0, Math.PI * 2);
      context.stroke();
      // Whip aerial.
      context.beginPath();
      context.moveTo(sx + 12, baseY - 15);
      context.lineTo(sx + 16, baseY - 31);
      context.stroke();
      break;
    }
    case "candelabra": {
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(sx, baseY);
      context.lineTo(sx, baseY - 12);
      context.moveTo(sx - 9, baseY - 12);
      context.lineTo(sx + 9, baseY - 12);
      context.stroke();
      for (const ox of [-9, 0, 9]) {
        context.fillStyle = PAPER;
        context.fillRect(sx + ox - 2, baseY - 24, 4, 12);
        context.strokeRect(sx + ox - 2, baseY - 24, 4, 12);
        context.fillStyle = "#e8c547";
        context.beginPath();
        context.ellipse(sx + ox, baseY - 27, 2.5, 4, 0, 0, Math.PI * 2);
        context.fill();
      }
      break;
    }
    case "toolbox": {
      context.fillStyle = ALERT;
      context.fillRect(sx - 13, baseY - 10, 26, 10);
      context.strokeRect(sx - 13, baseY - 10, 26, 10);
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(sx - 6, baseY - 10);
      context.quadraticCurveTo(sx, baseY - 19, sx + 6, baseY - 10);
      context.stroke();
      break;
    }
    case "ledger": {
      context.save();
      context.translate(sx, baseY);
      context.rotate(-0.1);
      context.fillStyle = "#6b5330";
      context.fillRect(-13, -9, 26, 9);
      context.strokeRect(-13, -9, 26, 9);
      context.fillStyle = PAPER;
      context.fillRect(-11, -12, 22, 4);
      context.strokeRect(-11, -12, 22, 4);
      context.restore();
      break;
    }
  }
  context.restore();
}

/** The prop this piece carries, or null when nothing stands on that kind of furniture. */
function propFor(
  roomIndex: number, piece: MatchSnapshot["furniture"][number],
): PropKind | null {
  if (!PROP_SURFACES.has(piece.type)) return null;
  const list = ROOM_PROPS[roomIndex];
  if (!list?.length) return null;
  // Only about two thirds of eligible pieces carry anything, or a room looks like a jumble.
  if (piece.id % 3 === 2) return null;
  return list[Math.floor(piece.id / 3) % list.length];
}

/**
 * Furniture, drawn per type rather than as one box with a decal.
 *
 * Each room is furnished from its own palette (see ROOM_FURNITURE), so the silhouettes are
 * what tell a records vault from a wine cellar at a glance. Box-shaped pieces share the
 * isometric carcass and differ in what is painted on their faces; the pieces that are not
 * box-shaped — tables, benches, barrels, planters, leaning paintings — are built from their
 * own geometry, because a decal on a cube still reads as a cube.
 */
function drawFurniture(
  context: CanvasRenderingContext2D,
  piece: MatchSnapshot["furniture"][number],
  trap: RoomTrap | null,
  highlighted: boolean,
  timeMs: number,
  reducedMotion: boolean,
  roomIndex: number,
): void {
  const { w, h } = FURNITURE_FOOTPRINT[piece.type];
  const height = FURNITURE_HEIGHT[piece.type];
  const shade = carcass(piece.emptied);
  const [sx, sy] = project(piece.x, piece.y);
  const { x, y } = piece;

  // A contact shadow, so a piece sits on the floor instead of hovering over it. Drawn from
  // the footprint, so a table casts a table-shaped patch and a barrel a round one.
  context.save();
  context.fillStyle = "rgba(20, 24, 15, 0.16)";
  context.beginPath();
  context.ellipse(sx, sy + 3, (w / 2) * AX * 1.02, (h / 2) * BY * 1.35, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  switch (piece.type) {
    case "cabinet": {
      // Three drawers with pull handles: the office silhouette people know instantly.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      for (let drawer = 0; drawer < 3; drawer++) {
        const v0 = 0.08 + drawer * 0.3;
        facePanel(context, x, y, w, h, height, "right", 0.12, 0.88, v0, v0 + 0.24, null);
        faceLine(context, x, y, w, h, height, "right", 0.38, 0.62, v0 + 0.12, 3);
      }
      break;
    }
    case "locker": {
      // Tall and narrow, vented at the top, with one full-height door seam and a handle.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      facePanel(context, x, y, w, h, height, "right", 0.1, 0.9, 0.06, 0.94, null);
      for (let slat = 0; slat < 4; slat++) {
        faceLine(context, x, y, w, h, height, "right", 0.25, 0.75, 0.74 + slat * 0.05, 1.5);
      }
      faceLine(context, x, y, w, h, height, "right", 0.76, 0.84, 0.45, 3);
      break;
    }
    case "safe": {
      // Squat and heavy, with a combination dial and two hinges.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      facePanel(context, x, y, w, h, height, "right", 0.14, 0.86, 0.12, 0.88, null);
      const [dx, dy] = project(x + w / 2, y);
      context.save();
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(dx, dy - height * 0.5, 7, 0, Math.PI * 2);
      context.stroke();
      for (let spoke = 0; spoke < 4; spoke++) {
        const angle = spoke * Math.PI / 2 + 0.4;
        context.beginPath();
        context.moveTo(dx + Math.cos(angle) * 3, dy - height * 0.5 + Math.sin(angle) * 3);
        context.lineTo(dx + Math.cos(angle) * 9, dy - height * 0.5 + Math.sin(angle) * 9);
        context.stroke();
      }
      context.restore();
      for (const v of [0.25, 0.7]) faceLine(context, x, y, w, h, height, "right", 0.06, 0.13, v, 3);
      break;
    }
    case "bookcase": {
      // Open shelving: four shelves of book spines, which also dates the room as a study.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      facePanel(context, x, y, w, h, height, "right", 0.08, 0.92, 0.06, 0.94,
        piece.emptied ? "#9aa384" : "#c7cfb4");
      for (let shelf = 0; shelf < 4; shelf++) {
        const base = 0.1 + shelf * 0.21;
        faceLine(context, x, y, w, h, height, "right", 0.08, 0.92, base, 2);
        // Spines of varying height, seeded off the piece id so a shelf never flickers.
        for (let book = 0; book < 6; book++) {
          const u = 0.14 + book * 0.12;
          const tall = ((piece.id * 7 + shelf * 13 + book * 3) % 5) / 40;
          facePanel(context, x, y, w, h, height, "right", u, u + 0.08, base, base + 0.12 + tall,
            (book + shelf) % 2 ? PAPER : "#8d967a", INK, 1);
        }
      }
      break;
    }
    case "console": {
      // A raked operator panel with a screen and two dials.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      facePanel(context, x, y, w, h, height, "right", 0.1, 0.62, 0.3, 0.86,
        piece.emptied ? "#6f775f" : "#3c4530", INK, 2);
      const [px, py] = project(x + w / 2, y + h * 0.28);
      context.save();
      context.fillStyle = piece.emptied ? "#8d967a" : SIGNAL;
      for (let bar = 0; bar < 3; bar++) {
        context.fillRect(px - 12, py - height * 0.72 + bar * 7, 7 + bar * 5, 3);
      }
      context.strokeStyle = INK;
      context.lineWidth = 2;
      for (const offset of [0.74, 0.88]) {
        const [cx, cy] = project(x + w / 2, y - h / 2 + h * offset);
        context.beginPath();
        context.arc(cx, cy - height * 0.55, 4.5, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
      break;
    }
    case "crate": {
      // Cross-braced planks on both visible faces.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right);
      for (const face of ["right", "left"] as const) {
        facePanel(context, x, y, w, h, height, face, 0.08, 0.92, 0.08, 0.92, null);
        facePanel(context, x, y, w, h, height, face, 0.08, 0.92, 0.46, 0.54, null, INK, 1.5);
        const a = facePanelCorners(x, y, w, h, height, face);
        context.save();
        context.strokeStyle = INK;
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(a.bl[0], a.bl[1]); context.lineTo(a.tr[0], a.tr[1]);
        context.moveTo(a.br[0], a.br[1]); context.lineTo(a.tl[0], a.tl[1]);
        context.stroke();
        context.restore();
      }
      break;
    }
    case "desk": {
      // A writing desk: top slab, one drawer pedestal, two legs, and papers on top.
      const topThickness = 7;
      leg(context, x - w * 0.42, y + h * 0.3, height - topThickness, shade.right);
      leg(context, x - w * 0.42, y - h * 0.3, height - topThickness, shade.right);
      isoBox(context, x + w * 0.22, y, w * 0.4, h * 0.82, height - topThickness,
        shade.top, shade.left, shade.right);
      facePanel(context, x + w * 0.22, y, w * 0.4, h * 0.82, height - topThickness,
        "right", 0.15, 0.85, 0.55, 0.85, null);
      faceLine(context, x + w * 0.22, y, w * 0.4, h * 0.82, height - topThickness,
        "right", 0.4, 0.6, 0.7, 3);
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right,
        height - topThickness);
      // A blotter and a couple of loose papers, so the top is not a blank slab.
      context.save();
      const [bx, by] = project(x - w * 0.14, y);
      context.fillStyle = piece.emptied ? "#8d967a" : "#3c4530";
      context.beginPath();
      context.ellipse(bx, by - height - 1, 15, 7, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = PAPER;
      context.strokeStyle = INK;
      context.lineWidth = 1.5;
      context.beginPath();
      context.ellipse(bx + 16, by - height - 3, 8, 4, 0.3, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();
      break;
    }
    case "table": {
      // Open underneath: four legs and a thin top, which reads nothing like a cabinet.
      const topThickness = 6;
      const legHeight = height - topThickness;
      for (const [lx, ly] of [
        [-w * 0.4, -h * 0.32], [w * 0.4, -h * 0.32], [-w * 0.4, h * 0.32], [w * 0.4, h * 0.32],
      ] as const) {
        leg(context, x + lx, y + ly, legHeight, shade.right);
      }
      // The top is a slab resting on the legs, not a box grown from the floor, so the legs
      // and the daylight between them are visible.
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right, legHeight);
      break;
    }
    case "bench": {
      // Backless, with four chunky legs and raised ends.
      //
      // Earlier versions gave it a back. A bench back is a thin vertical plane, and in this
      // projection a thin vertical plane fills a large quad on screen whatever you do to it:
      // rails merged, slats merged, and it read as a room divider every time. Taking the back
      // off removes the ambiguity entirely — the silhouette is now unmistakably something you
      // sit on.
      const seat = 7;
      const legHeight = height - seat;
      for (const [lx, ly] of [
        [-w * 0.38, -h * 0.26], [w * 0.38, -h * 0.26],
        [-w * 0.38, h * 0.26], [w * 0.38, h * 0.26],
      ] as const) {
        leg(context, x + lx, y + ly, legHeight, shade.right);
      }
      isoBox(context, x, y, w, h, height, shade.top, shade.left, shade.right, legHeight);
      // Raised ends, low enough that they read as arms rather than as walls.
      for (const px of [-w * 0.44, w * 0.44]) {
        isoBox(context, x + px, y, 9, h * 0.86, height + 11, shade.top, "#7c866a", shade.right);
      }
      // Planks along the seat, drawn on the top face.
      context.save();
      context.strokeStyle = "rgba(20,24,15,0.42)";
      context.lineWidth = 1.5;
      for (const across of [-0.16, 0.16]) {
        const [ax, ay] = project(x - w * 0.36, y + h * across);
        const [bx, by] = project(x + w * 0.36, y + h * across);
        context.beginPath();
        context.moveTo(ax, ay - height);
        context.lineTo(bx, by - height);
        context.stroke();
      }
      context.restore();
      break;
    }
    case "barrel": {
      // Curved staves and two iron hoops: the one round silhouette in the mansion.
      context.save();
      const rx = w * 0.46;
      const ry = w * 0.46 * (BY / AX);
      const bulge = 9;
      context.beginPath();
      context.moveTo(sx - rx, sy - ry);
      context.quadraticCurveTo(sx - rx - bulge, sy - height * 0.5, sx - rx, sy - height + ry * 0.2);
      context.lineTo(sx + rx, sy - height + ry * 0.2);
      context.quadraticCurveTo(sx + rx + bulge, sy - height * 0.5, sx + rx, sy - ry);
      context.closePath();
      context.fillStyle = shade.right;
      context.fill();
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.stroke();
      context.fillStyle = shade.top;
      context.beginPath();
      context.ellipse(sx, sy - height, rx, ry, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      // Staves down the face, then the hoops over them.
      context.lineWidth = 1;
      context.strokeStyle = "rgba(20,24,15,0.35)";
      for (const across of [-0.55, -0.2, 0.2, 0.55]) {
        context.beginPath();
        context.moveTo(sx + rx * across, sy - ry * 0.4);
        context.quadraticCurveTo(
          sx + (rx + bulge) * across, sy - height * 0.5,
          sx + rx * across, sy - height + ry * 0.4);
        context.stroke();
      }
      context.strokeStyle = INK;
      context.lineWidth = 3.5;
      for (const level of [0.3, 0.72]) {
        context.beginPath();
        context.moveTo(sx - rx - bulge * 0.72, sy - height * level);
        context.quadraticCurveTo(sx, sy - height * level + ry * 1.1, sx + rx + bulge * 0.72, sy - height * level);
        context.stroke();
      }
      context.restore();
      break;
    }
    case "planter": {
      // A tapered pot with a rim, and foliage above it.
      context.save();
      const rTop = w * 0.46;
      const rBottom = w * 0.3;
      const ryTop = rTop * (BY / AX);
      context.beginPath();
      context.moveTo(sx - rBottom, sy);
      context.lineTo(sx - rTop, sy - height);
      context.lineTo(sx + rTop, sy - height);
      context.lineTo(sx + rBottom, sy);
      context.closePath();
      context.fillStyle = shade.right;
      context.fill();
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.stroke();
      context.fillStyle = shade.top;
      context.beginPath();
      context.ellipse(sx, sy - height, rTop, ryTop, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (!piece.emptied) {
        context.fillStyle = "#4d6b2e";
        for (const [ox, oy, r] of [[-9, -14, 11], [9, -12, 10], [0, -24, 12]] as const) {
          context.beginPath();
          context.arc(sx + ox, sy - height + oy, r, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      }
      context.restore();
      break;
    }
    case "painting": {
      // A framed canvas leaning against the wall on a low crate, rather than hung flat.
      isoBox(context, x, y, w * 0.9, h, 10, shade.top, shade.left, shade.right);
      context.save();
      const fw = w * 0.42;
      context.translate(sx, sy - 10);
      context.transform(1, 0, -0.18, 1, 0, 0);
      context.fillStyle = shade.right;
      context.strokeStyle = INK;
      context.lineWidth = 2;
      context.fillRect(-fw, -height, fw * 2, height);
      context.strokeRect(-fw, -height, fw * 2, height);
      context.fillStyle = piece.emptied ? "#8d967a" : "#3c4530";
      context.fillRect(-fw + 6, -height + 6, fw * 2 - 12, height - 12);
      context.strokeStyle = SIGNAL;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(-fw + 10, -10);
      context.lineTo(-4, -height * 0.55);
      context.lineTo(fw - 10, -14);
      context.stroke();
      context.restore();
      break;
    }
  }
  context.restore();

  // Whatever the room leaves lying about, standing on the top surface.
  const prop = propFor(roomIndex, piece);
  if (prop) drawProp(context, prop, piece.x, piece.y - FURNITURE_FOOTPRINT[piece.type].h * 0.1, height);

  if (piece.emptied) {
    context.fillStyle = "rgba(20, 24, 15, 0.45)";
    context.font = "600 11px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("SEARCHED", sx, sy + 13);
  }

  if (trap) drawTrapMarker(context, piece.x, piece.y, height, trap, timeMs, reducedMotion);

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

/**
 * A clock or a portrait hanging on a wall.
 *
 * Drawn flat against the wall plane rather than as an isometric box, and skewed to sit in it:
 * the north wall recedes one way, the west wall the other. These are searchable and trappable
 * like any other furniture, which is the point of them — a wall safe behind a portrait is the
 * oldest hiding place in the business.
 */
function drawWallFurniture(
  context: CanvasRenderingContext2D,
  piece: MatchSnapshot["furniture"][number],
  trap: RoomTrap | null,
  highlighted: boolean,
  timeMs: number,
  reducedMotion: boolean,
): void {
  const onNorth = piece.y === 0;
  const [sx, sy] = project(piece.x, piece.y);
  const { w } = FURNITURE_FOOTPRINT[piece.type];
  const drop = FURNITURE_HEIGHT[piece.type];
  const top = sy - WALL_HEIGHT + 26;
  const shade = carcass(piece.emptied);

  context.save();
  context.translate(sx, top);
  // Shear into the wall's plane. BY/AX is the run of one wall unit across the screen.
  context.transform(1, onNorth ? BY / AX : -BY / AX, 0, 1, 0, 0);
  context.strokeStyle = INK;
  context.lineWidth = 2;

  if (piece.type === "wallclock") {
    const r = w * 0.42;
    context.fillStyle = shade.right;
    context.beginPath();
    context.arc(0, drop / 2, r, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = INK;
    for (let tick = 0; tick < 12; tick++) {
      const angle = (tick / 12) * Math.PI * 2;
      context.fillRect(Math.cos(angle) * (r - 5) - 1, drop / 2 + Math.sin(angle) * (r - 5) - 1, 2, 2);
    }
    if (!piece.emptied) {
      // Hands frozen at a plausible hour; they are scenery, not a clock.
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(0, drop / 2);
      context.lineTo(0, drop / 2 - r * 0.6);
      context.moveTo(0, drop / 2);
      context.lineTo(r * 0.45, drop / 2 + r * 0.2);
      context.stroke();
    }
  } else {
    // A framed portrait: frame, mount, and a head-and-shoulders silhouette.
    const halfW = w * 0.42;
    context.fillStyle = shade.right;
    context.beginPath();
    context.roundRect(-halfW, 0, halfW * 2, drop, 3);
    context.fill();
    context.stroke();
    context.fillStyle = piece.emptied ? "#8d967a" : "#e9edda";
    context.fillRect(-halfW + 6, 6, halfW * 2 - 12, drop - 12);
    context.strokeRect(-halfW + 6, 6, halfW * 2 - 12, drop - 12);
    if (!piece.emptied) {
      context.fillStyle = WALL_DARK;
      context.beginPath();
      context.arc(0, drop * 0.38, halfW * 0.34, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(-halfW * 0.5, drop - 8);
      context.quadraticCurveTo(0, drop * 0.5, halfW * 0.5, drop - 8);
      context.fill();
    }
  }
  context.restore();

  if (piece.emptied) {
    context.save();
    context.fillStyle = "rgba(20, 24, 15, 0.5)";
    context.font = "600 10px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("SEARCHED", sx, top + drop + 13);
    context.restore();
  }

  if (highlighted) {
    context.save();
    context.strokeStyle = SIGNAL;
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(sx - w * 0.5, top - 6, w, drop + 12, 6);
    context.stroke();
    context.restore();
  }

  // The pennant sits above the hanging, on the wall, not on the floor beneath it.
  if (trap) drawTrapMarker(context, piece.x, piece.y, WALL_HEIGHT - 16, trap, timeMs, reducedMotion);
}

/** The four screen corners of a box face, for detail that is not axis-aligned. */
function facePanelCorners(
  x: number, y: number, w: number, d: number, height: number, face: "right" | "left",
) {
  const hw = w / 2, hd = d / 2;
  const at = (u: number, v: number) => {
    const [sx, sy] = face === "right"
      ? project(x + hw, y - hd + u * d)
      : project(x - hw + u * w, y + hd);
    return [sx, sy - v * height] as const;
  };
  return { bl: at(0.1, 0.1), br: at(0.9, 0.1), tl: at(0.1, 0.9), tr: at(0.9, 0.9) };
}

/** A warning pennant over a trapped furniture piece or doorway. Green is yours, amber is not. */
export function drawTrapMarker(
  context: CanvasRenderingContext2D, worldX: number, worldY: number, lift: number,
  trap: RoomTrap, timeMs: number, reducedMotion: boolean,
): void {
  const [sx, sy] = project(worldX, worldY);
  const top = sy - lift;
  const pulse = reducedMotion ? 1 : 0.55 + 0.45 * (1 + Math.sin(timeMs / 220)) / 2;
  context.save();
  context.globalAlpha = pulse;
  context.fillStyle = trap.mine ? SIGNAL : ALERT;
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(sx, top - 26);
  context.lineTo(sx + 11, top - 8);
  context.lineTo(sx - 11, top - 8);
  context.closePath();
  context.fill();
  context.stroke();
  context.globalAlpha = 1;
  context.fillStyle = INK;
  context.font = "700 11px ui-monospace, monospace";
  context.textAlign = "center";
  context.fillText("!", sx, top - 11);
  context.restore();
}

/**
 * One glyph per carryable, drawn in a box of `size` centred on (x, y). Used both for items
 * lying on the floor and for the on-screen inventory, so the two always agree.
 */
export function drawCarryableGlyph(
  context: CanvasRenderingContext2D, x: number, y: number, size: number,
  item: Carryable, ink = INK,
): void {
  const u = size / 16;
  context.save();
  context.translate(x - size / 2, y - size / 2);
  context.strokeStyle = ink;
  context.fillStyle = ink;
  context.lineWidth = Math.max(1.2, 1.6 * u);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  switch (item) {
    case "documents":
      context.rect(3 * u, 2 * u, 10 * u, 12 * u);
      context.moveTo(5 * u, 5 * u); context.lineTo(11 * u, 5 * u);
      context.moveTo(5 * u, 8 * u); context.lineTo(11 * u, 8 * u);
      context.moveTo(5 * u, 11 * u); context.lineTo(9 * u, 11 * u);
      break;
    case "passport":
      context.rect(4 * u, 2 * u, 9 * u, 12 * u);
      context.moveTo(4 * u, 2 * u); context.lineTo(3 * u, 3 * u);
      context.lineTo(3 * u, 15 * u); context.lineTo(4 * u, 14 * u);
      context.moveTo(11 * u, 8 * u);
      context.arc(8.5 * u, 8 * u, 2.5 * u, 0, Math.PI * 2);
      break;
    case "cash":
      context.rect(2 * u, 4 * u, 12 * u, 8 * u);
      context.moveTo(10.5 * u, 8 * u);
      context.arc(8 * u, 8 * u, 2.5 * u, 0, Math.PI * 2);
      context.moveTo(4 * u, 6 * u); context.lineTo(4.4 * u, 6 * u);
      context.moveTo(12 * u, 10 * u); context.lineTo(11.6 * u, 10 * u);
      break;
    case "disguise":
      context.moveTo(2 * u, 7 * u); context.lineTo(14 * u, 7 * u);
      context.moveTo(5.5 * u, 7 * u);
      context.arc(4 * u, 7 * u, 1.5 * u, 0, Math.PI * 2);
      context.moveTo(13.5 * u, 7 * u);
      context.arc(12 * u, 7 * u, 1.5 * u, 0, Math.PI * 2);
      context.moveTo(6 * u, 11 * u);
      context.quadraticCurveTo(8 * u, 13.5 * u, 10 * u, 11 * u);
      break;
    case "medkit":
      context.rect(2 * u, 4 * u, 12 * u, 9 * u);
      context.moveTo(8 * u, 6 * u); context.lineTo(8 * u, 11 * u);
      context.moveTo(5.5 * u, 8.5 * u); context.lineTo(10.5 * u, 8.5 * u);
      break;
    case "vest":
      context.moveTo(8 * u, 2 * u);
      context.lineTo(13 * u, 4.5 * u);
      context.lineTo(13 * u, 9 * u);
      context.quadraticCurveTo(13 * u, 13 * u, 8 * u, 14.5 * u);
      context.quadraticCurveTo(3 * u, 13 * u, 3 * u, 9 * u);
      context.lineTo(3 * u, 4.5 * u);
      context.closePath();
      break;
    case "knife":
      context.moveTo(3 * u, 13 * u); context.lineTo(10 * u, 6 * u);
      context.lineTo(13 * u, 2 * u); context.lineTo(12 * u, 6 * u);
      context.lineTo(6 * u, 12 * u); context.closePath();
      context.moveTo(3 * u, 13 * u); context.lineTo(5 * u, 15 * u);
      break;
  }
  context.stroke();
  context.restore();
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
  context.roundRect(sx - 14, sy - 32, 28, 26, 4);
  context.fill();
  context.stroke();
  drawCarryableGlyph(context, sx, sy - 19, 18, item as Carryable);
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
  context.fillText(carryableLabel(item as Carryable), sx, sy + 17);
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
    drawFriendPixels(context, rows, left, top, 5);
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
  const label = `${actor.friendName ? `${actor.codename} (${actor.friendName})` : actor.codename}${actor.genesis ? " ◆" : ""}`;
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

  // A health bar by the feet, shown only once an agent has actually been hurt.
  if (actor.hp > 0 && actor.hp < actor.maxHp) {
    const barWidth = 44;
    const barY = Math.round(y) + 8;
    const fraction = Math.max(0, Math.min(1, actor.hp / Math.max(1, actor.maxHp)));
    context.save();
    context.fillStyle = "rgba(238,241,228,0.95)";
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(Math.round(x) - barWidth / 2, barY, barWidth, 7, 3);
    context.fill();
    context.stroke();
    context.fillStyle = fraction > 0.5 ? SIGNAL : ALERT;
    context.beginPath();
    context.roundRect(Math.round(x) - barWidth / 2 + 2, barY + 2, (barWidth - 4) * fraction, 3, 1.5);
    context.fill();
    context.restore();
  }

  // Anyone carrying the stiletto advertises it, so the room knows who to avoid.
  if (actor.hasKnife) {
    context.save();
    context.fillStyle = ALERT;
    context.strokeStyle = INK;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(Math.round(x) + 26, top + 16, 10, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    drawCarryableGlyph(context, Math.round(x) + 26, top + 16, 13, "knife", INK);
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
    // Thrust out along the way the agent is facing, and back again, so a blow reads as
    // aimed rather than as a flash around the body. Spy vs Spy's whole tell was the weapon
    // sticking out in front of you, and it is what makes a near miss legible.
    const swing = input.reducedMotion
      ? 0.6
      : 1 - Math.max(0, Math.min(1, actor.attackingMs / ATTACK_WINDUP_MS));
    const reach = Math.sin(Math.max(0, Math.min(1, swing)) * Math.PI);
    const [dx, dy] = facingScreenDir(actor.facing);
    const handX = Math.round(x) + dx * 10;
    const handY = Math.round(y) - 26 + dy * 10;

    context.save();
    context.translate(handX, handY);
    context.rotate(Math.atan2(dy, dx));
    context.translate(reach * (actor.hasKnife ? 26 : 16), 0);
    context.lineJoin = "round";
    context.strokeStyle = INK;

    if (actor.hasKnife) {
      // A stiletto: tapered blade, crossguard and grip, so it is unmistakably a blade.
      context.fillStyle = "#2b3220";
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(-17, -2.5, 12, 5, 2);
      context.fill();
      context.stroke();
      context.fillStyle = WALL_DARK;
      context.beginPath();
      context.roundRect(-6, -7, 3.5, 14, 1.5);
      context.fill();
      context.stroke();
      context.fillStyle = PAPER;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(-2.5, -3.4);
      context.lineTo(26, 0);
      context.lineTo(-2.5, 3.4);
      context.closePath();
      context.fill();
      context.stroke();
      // A glint down the edge at full extension.
      if (reach > 0.55) {
        context.strokeStyle = SIGNAL;
        context.lineWidth = 1.5;
        context.globalAlpha = (reach - 0.55) / 0.45;
        context.beginPath();
        context.moveTo(0, -1.2);
        context.lineTo(21, -0.3);
        context.stroke();
      }
    } else {
      // A bare fist on a short forearm.
      context.strokeStyle = INK;
      context.lineWidth = 5;
      context.beginPath();
      context.moveTo(-10, 0);
      context.lineTo(7, 0);
      context.stroke();
      context.fillStyle = PAPER;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(11, 0, 6, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (reach > 0.6) {
        context.strokeStyle = ALERT;
        context.lineWidth = 2;
        context.globalAlpha = (reach - 0.6) / 0.4;
        for (const angle of [-0.6, 0, 0.6]) {
          context.beginPath();
          context.moveTo(18 + Math.cos(angle) * 2, Math.sin(angle) * 4);
          context.lineTo(18 + Math.cos(angle) * 9, Math.sin(angle) * 11);
          context.stroke();
        }
      }
    }
    context.restore();
  }
}

// --- Effects -----------------------------------------------------------------------------

/** One live effect, with the elapsed time the caller has tracked across snapshots. */
export type ActiveEffect = Readonly<{ kind: EffectKind; x: number; y: number; elapsedMs: number }>;

/**
 * Trap detonations and landed blows, drawn over the depth-sorted room so a detonation is
 * never hidden behind the furniture it was planted on. Each trap type gets its own shape
 * and its own motion, so what went off is readable without the log.
 *
 * Reduced motion holds each effect near its most legible frame instead of animating.
 */
function drawEffect(
  context: CanvasRenderingContext2D, effect: ActiveEffect, reducedMotion: boolean,
): void {
  const span = EFFECT_DURATION_MS[effect.kind];
  const t = reducedMotion ? 0.35 : Math.max(0, Math.min(1, effect.elapsedMs / span));
  const [sx, sy] = project(effect.x, effect.y);
  const x = Math.round(sx);
  const y = Math.round(sy);
  const fade = 1 - t;

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  switch (effect.kind) {
    case "bomb": {
      // A flash, a shockwave ring travelling out, and soot thrown clear of it.
      if (t < 0.18) {
        context.globalAlpha = 1 - t / 0.18;
        context.fillStyle = PAPER;
        context.beginPath();
        context.ellipse(x, y - 18, 46, 24, 0, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = fade;
      context.strokeStyle = ALERT;
      context.lineWidth = Math.max(1, 5 * fade);
      context.beginPath();
      context.ellipse(x, y, 16 + t * 62, (16 + t * 62) * BY / AX, 0, 0, Math.PI * 2);
      context.stroke();

      context.fillStyle = INK;
      for (let index = 0; index < 8; index++) {
        const angle = (index / 8) * Math.PI * 2 + 0.3;
        const reach = 14 + t * 52;
        const size = Math.max(1, 5 * fade);
        context.beginPath();
        context.arc(x + Math.cos(angle) * reach, y - t * 26 + Math.sin(angle) * reach * (BY / AX),
          size, 0, Math.PI * 2);
        context.fill();
      }
      break;
    }
    case "spring": {
      // A bolt snapping shut: spikes drive inward, then a hard metallic star.
      const close = Math.min(1, t / 0.3);
      context.globalAlpha = fade;
      context.strokeStyle = ALERT;
      context.lineWidth = 3;
      for (let index = 0; index < 6; index++) {
        const angle = (index / 6) * Math.PI * 2;
        const outer = 46 - close * 30;
        const inner = outer - 14;
        context.beginPath();
        context.moveTo(x + Math.cos(angle) * outer, y - 10 + Math.sin(angle) * outer * (BY / AX));
        context.lineTo(x + Math.cos(angle) * inner, y - 10 + Math.sin(angle) * inner * (BY / AX));
        context.stroke();
      }
      if (t > 0.25) {
        context.globalAlpha = fade;
        context.strokeStyle = PAPER;
        context.lineWidth = 2;
        for (let index = 0; index < 4; index++) {
          const angle = (index / 4) * Math.PI + 0.4;
          const reach = 10 + (t - 0.25) * 34;
          context.beginPath();
          context.moveTo(x - Math.cos(angle) * reach, y - 10 - Math.sin(angle) * reach * (BY / AX));
          context.lineTo(x + Math.cos(angle) * reach, y - 10 + Math.sin(angle) * reach * (BY / AX));
          context.stroke();
        }
      }
      break;
    }
    case "bucket": {
      // The pail tips over the head, water sheets down, droplets scatter, a puddle stays.
      const fall = Math.min(1, t / 0.28);
      context.globalAlpha = Math.min(1, fade * 1.6);
      context.fillStyle = WALL_DARK;
      const pailY = y - 74 + fall * 40;
      context.fillRect(x - 13, Math.round(pailY), 26, 16);
      context.fillStyle = INK;
      context.fillRect(x - 13, Math.round(pailY), 26, 3);

      if (t > 0.2) {
        context.globalAlpha = fade * 0.75;
        context.fillStyle = "#7fb0c4";
        const sheet = Math.min(1, (t - 0.2) / 0.3);
        context.fillRect(x - 9, Math.round(pailY) + 14, 18, Math.round(sheet * 44));
        for (let index = 0; index < 7; index++) {
          const angle = (index / 7) * Math.PI * 2;
          const reach = sheet * 40;
          context.beginPath();
          context.arc(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach * (BY / AX) - 4,
            Math.max(1, 3 * fade), 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = fade * 0.5;
      context.fillStyle = "#7fb0c4";
      context.beginPath();
      context.ellipse(x, y, 10 + t * 22, (10 + t * 22) * BY / AX, 0, 0, Math.PI * 2);
      context.fill();
      break;
    }
    case "slash": {
      // The stiletto: a bright arc swept through the target, with a thin trailing edge.
      context.globalAlpha = fade;
      const sweep = -Math.PI * 0.75 + t * Math.PI * 1.1;
      context.strokeStyle = PAPER;
      context.lineWidth = 4;
      context.beginPath();
      context.arc(x, y - 26, 30, sweep, sweep + Math.PI * 0.5);
      context.stroke();
      context.strokeStyle = ALERT;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y - 26, 36, sweep + 0.1, sweep + Math.PI * 0.42);
      context.stroke();
      break;
    }
    case "damage1":
    case "damage2": {
      // Rises and fades above the victim. Two damage reads heavier, in weight and colour.
      const heavy = effect.kind === "damage2";
      context.globalAlpha = Math.min(1, fade * 1.7);
      context.textAlign = "center";
      context.font = heavy ? "800 26px ui-monospace, monospace" : "700 20px ui-monospace, monospace";
      context.lineWidth = 4;
      context.strokeStyle = INK;
      context.fillStyle = heavy ? ALERT : PAPER;
      const lift = y - 48 - t * 34;
      context.strokeText(`-${heavy ? 2 : 1}`, x, lift);
      context.fillText(`-${heavy ? 2 : 1}`, x, lift);
      break;
    }
    case "impact": {
      // A bare fist: a short four-point starburst, no sweep.
      context.globalAlpha = fade;
      context.strokeStyle = ALERT;
      context.lineWidth = 3;
      for (let index = 0; index < 4; index++) {
        const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
        const inner = 8 + t * 6;
        const outer = inner + 14 * fade + 6;
        context.beginPath();
        context.moveTo(x + Math.cos(angle) * inner, y - 26 + Math.sin(angle) * inner);
        context.lineTo(x + Math.cos(angle) * outer, y - 26 + Math.sin(angle) * outer);
        context.stroke();
      }
      break;
    }
  }
  context.restore();
}

/** How long the red edge lingers after taking a blow. */
export const HURT_FLASH_MS = 420;

/**
 * A red vignette over the room after taking a hit.
 *
 * Drawn on the canvas rather than as a CSS overlay so it cannot be missed on a phone, where
 * the HUD already crowds the edges. `strength` runs 1 at the moment of the blow to 0.
 */
export function drawHurtVignette(context: CanvasRenderingContext2D, strength: number): void {
  const peak = Math.max(0, Math.min(1, strength));
  if (peak <= 0) return;
  const edge = context.createRadialGradient(
    VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.28,
    VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.78,
  );
  edge.addColorStop(0, "rgba(228,87,46,0)");
  edge.addColorStop(1, `rgba(228,87,46,${(0.55 * peak).toFixed(3)})`);
  context.save();
  context.fillStyle = edge;
  context.fillRect(0, 0, VIEW_W, VIEW_H);
  context.restore();
}

/** Screen point to world point, for tap-to-walk. Exact inverse of project(). */
export function unproject(screenX: number, screenY: number): [number, number] {
  const u = (screenX - CX + OFF) / AX;
  const v = (screenY - CY) / BY;
  return [(v + u) / 2, (v - u) / 2];
}

// --- Title screen ------------------------------------------------------------------------

/**
 * Draws a Friend's canonical pixels at an arbitrary integer scale, with the white one-pixel
 * halo and black mask the artwork routine requires. Shared by the agents in the room and by
 * the large portrait on the title screen, so the treatment can never drift between them.
 */
function drawFriendPixels(
  context: CanvasRenderingContext2D, rows: readonly string[],
  left: number, top: number, scale: number,
): void {
  const pixels: [number, number][] = [];
  rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "#") pixels.push([px, py]); }));
  context.fillStyle = "#fff";
  for (const [px, py] of pixels) {
    context.fillRect(left + px * scale - scale, top + py * scale - scale, scale * 3, scale * 3);
  }
  context.fillStyle = "#000";
  for (const [px, py] of pixels) context.fillRect(left + px * scale, top + py * scale, scale, scale);
}

/**
 * The attract screen. It has to answer "what is this?" in the two seconds before somebody
 * decides whether to press anything, so it shows the embassy at night, the agent they will
 * actually be playing at portrait scale, and the four things they have to come out with.
 *
 * Reduced motion stops the searchlight and the walk cycle rather than removing them.
 */
export function drawTitleScreen(
  context: CanvasRenderingContext2D,
  options: {
    timeMs: number; reducedMotion: boolean;
    sprites: GenerationSprites | "loading" | "error" | undefined;
    codename: string; friendName: string | null; friendId: string;
  },
): void {
  const { timeMs, reducedMotion } = options;
  const t = reducedMotion ? 0 : timeMs / 1000;
  const horizon = 452;

  context.save();
  context.imageSmoothingEnabled = false;

  const sky = context.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#0b0f07");
  sky.addColorStop(0.7, "#1b2313");
  sky.addColorStop(1, "#33401f");
  context.fillStyle = sky;
  context.fillRect(0, 0, VIEW_W, horizon);

  // A fixed star field: hashed from the index so it does not shimmer between frames.
  context.fillStyle = "rgba(238,241,228,0.55)";
  for (let index = 0; index < 70; index++) {
    const sx = (index * 947) % VIEW_W;
    const sy = (index * 613) % (horizon - 120);
    const twinkle = reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(t * 1.6 + index);
    context.globalAlpha = 0.25 + twinkle * 0.5;
    context.fillRect(sx, sy, 2, 2);
  }
  context.globalAlpha = 1;

  // Searchlight sweeping the sky from behind the building.
  const sweep = Math.sin(t * 0.35) * 0.5;
  context.save();
  context.translate(214, horizon + 10);
  context.rotate(-Math.PI / 2 + sweep);
  const beam = context.createLinearGradient(0, 0, 560, 0);
  beam.addColorStop(0, "rgba(204,255,0,0.22)");
  beam.addColorStop(1, "rgba(204,255,0,0)");
  context.fillStyle = beam;
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(560, -76);
  context.lineTo(560, 76);
  context.closePath();
  context.fill();
  context.restore();

  // Ground.
  context.fillStyle = "#26301a";
  context.fillRect(0, horizon, VIEW_W, VIEW_H - horizon);
  context.strokeStyle = "rgba(204,255,0,0.18)";
  context.lineWidth = 1;
  for (let index = 1; index < 7; index++) {
    const gy = horizon + index * index * 4;
    if (gy > VIEW_H) break;
    context.beginPath();
    context.moveTo(0, gy);
    context.lineTo(VIEW_W, gy);
    context.stroke();
  }

  // The embassy itself: a flat silhouette with lit windows and a flag.
  context.fillStyle = "#11160c";
  context.fillRect(96, 300, 236, horizon - 300);
  context.fillRect(60, 356, 36, horizon - 356);
  context.fillRect(332, 356, 36, horizon - 356);
  context.beginPath();
  context.moveTo(96, 300);
  context.lineTo(214, 252);
  context.lineTo(332, 300);
  context.closePath();
  context.fill();
  context.fillRect(212, 214, 4, 42);
  context.fillStyle = ALERT;
  context.beginPath();
  context.moveTo(216, 216);
  context.lineTo(216 + 30, 224);
  context.lineTo(216, 234);
  context.closePath();
  context.fill();

  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 5; column++) {
      // One window per row is dark, rotating slowly, so the building looks occupied.
      const lit = reducedMotion || (column + row) % 5 !== Math.floor(t * 0.7) % 5;
      context.fillStyle = lit ? "#e8c547" : "#1d2413";
      context.fillRect(118 + column * 42, 318 + row * 40, 22, 26);
    }
  }
  context.fillStyle = "#e8c547";
  context.fillRect(196, 412, 36, horizon - 412);

  // Title block.
  context.textAlign = "left";
  context.fillStyle = SIGNAL;
  context.font = "800 74px ui-monospace, monospace";
  context.fillText("THE RARE", 452, 190);
  context.fillText("AGENCY", 452, 262);
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.strokeText("THE RARE", 452, 190);
  context.strokeText("AGENCY", 452, 262);

  context.fillStyle = PAPER;
  context.font = "700 17px ui-monospace, monospace";
  context.fillText("SPY VS SPY, RUN BY RARE FRIENDS", 456, 296);
  context.fillStyle = "rgba(238,241,228,0.66)";
  context.font = "600 14px ui-monospace, monospace";
  context.fillText("2-4 agents · one mansion · four things worth stealing", 456, 320);

  // The four objectives, as the glyphs used everywhere else in the game.
  MISSION_ITEMS.forEach((item, index) => {
    const gx = 470 + index * 74;
    const gy = 372;
    context.save();
    context.globalAlpha = 0.95;
    context.fillStyle = "rgba(20,24,15,0.72)";
    context.strokeStyle = "rgba(204,255,0,0.5)";
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(gx - 26, gy - 26, 52, 52, 8);
    context.fill();
    context.stroke();
    context.restore();
    drawCarryableGlyph(context, gx, gy, 30, item, SIGNAL);
  });

  // The agent, stood on the apron at portrait scale.
  const entry = options.sprites;
  const scale = 9;
  const left = 214 - (16 * scale) / 2;
  const top = horizon - 16 * scale + 12;
  context.save();
  context.fillStyle = "rgba(0,0,0,0.42)";
  context.beginPath();
  context.ellipse(214, horizon + 14, 62, 15, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  if (entry && entry !== "loading" && entry !== "error") {
    const frameIndex = reducedMotion ? 0 : Math.floor(timeMs / 130) % 8;
    const rows = spriteFrame(entry, "down", !reducedMotion, frameIndex, "right").frame.rows;
    context.save();
    context.beginPath();
    context.rect(left - scale, top - scale, 16 * scale + scale * 2, 16 * scale + scale * 2);
    context.clip();
    drawFriendPixels(context, rows, left, top, scale);
    context.restore();
  } else {
    context.save();
    context.strokeStyle = "rgba(238,241,228,0.5)";
    context.setLineDash([6, 6]);
    context.lineWidth = 3;
    context.strokeRect(left + 24, top + 20, 96, 124);
    context.setLineDash([]);
    context.fillStyle = "rgba(238,241,228,0.7)";
    context.font = "600 13px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(entry === "error" ? "ARTWORK OFFLINE" : "LOADING ARTWORK…", 214, top + 88);
    context.restore();
  }

  context.restore();
}

/**
 * The chosen agent alone, spotlit, at portrait scale.
 *
 * Shown once before the title screen so the player sees who they picked while the SDK's own
 * picker — which lists Friends as text only — is still one click behind them.
 */
export function drawAgentPortrait(
  context: CanvasRenderingContext2D,
  options: {
    timeMs: number; reducedMotion: boolean;
    sprites: GenerationSprites | "loading" | "error" | undefined;
  },
): void {
  const { timeMs, reducedMotion } = options;
  // The agent stands in the upper two thirds; the caption card below it owns the rest.
  const floor = 352;

  context.save();
  context.imageSmoothingEnabled = false;

  const backdrop = context.createLinearGradient(0, 0, 0, VIEW_H);
  backdrop.addColorStop(0, "#0b0f07");
  backdrop.addColorStop(0.72, "#222b16");
  backdrop.addColorStop(1, "#141a0d");
  context.fillStyle = backdrop;
  context.fillRect(0, 0, VIEW_W, VIEW_H);

  // A scrim under the caption, so the card reads whatever the artwork behind it is doing.
  const scrim = context.createLinearGradient(0, floor + 40, 0, VIEW_H);
  scrim.addColorStop(0, "rgba(8,11,6,0)");
  scrim.addColorStop(0.45, "rgba(8,11,6,0.82)");
  scrim.addColorStop(1, "rgba(8,11,6,0.94)");

  // A single overhead spot, so the agent reads as the subject rather than a sprite on a field.
  const cone = context.createRadialGradient(VIEW_W / 2, floor - 150, 40, VIEW_W / 2, floor - 90, 330);
  cone.addColorStop(0, "rgba(204,255,0,0.20)");
  cone.addColorStop(1, "rgba(204,255,0,0)");
  context.fillStyle = cone;
  context.fillRect(0, 0, VIEW_W, VIEW_H);
  context.fillStyle = scrim;
  context.fillRect(0, floor + 40, VIEW_W, VIEW_H - floor - 40);

  context.fillStyle = "rgba(0,0,0,0.45)";
  context.beginPath();
  context.ellipse(VIEW_W / 2, floor + 16, 96, 22, 0, 0, Math.PI * 2);
  context.fill();

  const entry = options.sprites;
  const scale = 12;
  const left = VIEW_W / 2 - (16 * scale) / 2;
  const top = floor - 16 * scale + 14;

  if (entry && entry !== "loading" && entry !== "error") {
    const frameIndex = reducedMotion ? 0 : Math.floor(timeMs / 150) % 8;
    const rows = spriteFrame(entry, "down", !reducedMotion, frameIndex, "right").frame.rows;
    context.save();
    context.beginPath();
    context.rect(left - scale, top - scale, 16 * scale + scale * 2, 16 * scale + scale * 2);
    context.clip();
    drawFriendPixels(context, rows, left, top, scale);
    context.restore();
  } else {
    context.save();
    context.strokeStyle = "rgba(238,241,228,0.5)";
    context.setLineDash([8, 8]);
    context.lineWidth = 3;
    context.strokeRect(left + 30, top + 26, 132, 166);
    context.setLineDash([]);
    context.fillStyle = "rgba(238,241,228,0.75)";
    context.font = "600 15px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(
      entry === "error" ? "ARTWORK OFFLINE" : "LOADING ARTWORK…", VIEW_W / 2, top + 116);
    context.restore();
  }

  context.restore();
}

// --- Escape sequence ---------------------------------------------------------------------

export const ESCAPE_DURATION_MS = 6200;

/**
 * Plays when an agent carries the full set through the courtyard gate: a dash across the
 * apron and a departure. Drawn on the same canvas at the same 960x640, so it inherits the
 * embassy's palette rather than introducing a second visual language.
 *
 * `progress` runs 0 to 1. Reduced motion holds the final frame instead of animating.
 */
export function drawEscapeScene(
  context: CanvasRenderingContext2D,
  options: {
    progress: number; codename: string; friendName: string | null;
    sprites: GenerationSprites | "loading" | "error" | undefined;
    reducedMotion: boolean; timeMs: number; won: boolean;
  },
): void {
  const t = options.reducedMotion ? 0.82 : Math.max(0, Math.min(1, options.progress));
  const horizon = 430;

  context.save();
  context.imageSmoothingEnabled = false;

  // Night sky graded down to the apron.
  const sky = context.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#0d1108");
  sky.addColorStop(1, "#2d3720");
  context.fillStyle = sky;
  context.fillRect(0, 0, VIEW_W, horizon);

  // Stars, fixed by index so they do not shimmer between frames.
  context.fillStyle = "rgba(238,241,228,0.75)";
  for (let i = 0; i < 46; i++) {
    const sx = (i * 197) % VIEW_W;
    const sy = (i * 83) % (horizon - 60);
    const twinkle = options.reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(options.timeMs / 500 + i);
    context.globalAlpha = 0.25 + 0.55 * twinkle;
    context.fillRect(sx, sy, 2, 2);
  }
  context.globalAlpha = 1;

  // Control tower and terminal on the far side.
  context.fillStyle = "#1c2313";
  context.fillRect(60, horizon - 150, 120, 150);
  context.fillRect(640, horizon - 96, 240, 96);
  context.fillStyle = SIGNAL;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if ((row + col + options.codename.length) % 3 === 0) continue;
      context.fillRect(76 + col * 34, horizon - 138 + row * 26, 16, 12);
    }
  }
  for (let col = 0; col < 8; col++) context.fillRect(660 + col * 28, horizon - 80, 18, 14);

  // Apron.
  context.fillStyle = "#3b4529";
  context.fillRect(0, horizon, VIEW_W, VIEW_H - horizon);
  context.strokeStyle = "#55603c";
  context.lineWidth = 3;
  for (let x = -100; x < VIEW_W + 100; x += 120) {
    context.beginPath();
    context.moveTo(x, horizon);
    context.lineTo(x - 140, VIEW_H);
    context.stroke();
  }
  context.setLineDash([46, 34]);
  context.strokeStyle = SIGNAL;
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(0, horizon + 132);
  context.lineTo(VIEW_W, horizon + 96);
  context.stroke();
  context.setLineDash([]);

  // The aircraft taxis in, holds while the agent boards, then climbs away up the frame
  // rather than straight off the side. Leaving sideways at speed emptied the apron for the
  // last second and a half, so the payoff ended on nothing.
  const TAXI_END = 0.46;
  const ROLL_START = 0.62;
  const roll = Math.max(0, (t - ROLL_START) / (1 - ROLL_START));
  const planeX = t < TAXI_END
    ? -300 + (t / TAXI_END) * 780
    : 480 + roll * roll * 430;
  const planeY = horizon - 40 - roll * roll * 300;
  // Receding as it climbs, so it reads as distance rather than as a sprite sliding away.
  const planeScale = 1 - roll * 0.55;
  drawPlane(context, planeX, planeY, options.reducedMotion ? 0 : options.timeMs, planeScale);

  // The agent sprints on and boards just as the roll begins.
  if (t < ROLL_START) {
    const runX = 90 + Math.min(1, t / (ROLL_START - 0.02)) * 380;
    const bob = options.reducedMotion ? 0 : Math.abs(Math.sin(options.timeMs / 90)) * 5;
    drawEscapeAgent(context, runX, horizon + 96 - bob, options.sprites, options.timeMs, options.reducedMotion);
  }

  // Caption.
  const name = options.friendName ? `${options.codename} (${options.friendName})` : options.codename;
  context.textAlign = "center";
  context.fillStyle = PAPER;
  context.font = "700 34px ui-monospace, monospace";
  // The verdict first and largest: whoever is watching wants to know if it was them.
  context.font = "800 46px ui-monospace, monospace";
  context.fillStyle = options.won ? SIGNAL : ALERT;
  context.fillText(options.won ? "YOU WON" : "YOU LOST", VIEW_W / 2, 74);
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.strokeText(options.won ? "YOU WON" : "YOU LOST", VIEW_W / 2, 74);

  context.fillStyle = PAPER;
  context.font = "700 22px ui-monospace, monospace";
  context.fillText(options.won ? "EXFILTRATED" : "THE GATE CLOSES", VIEW_W / 2, 108);
  context.font = "600 16px ui-monospace, monospace";
  context.fillStyle = "rgba(238,241,228,0.8)";
  context.fillText(
    options.won ? `${name} cleared the embassy with the full set.` : `${name} did not make the flight.`,
    VIEW_W / 2, 136,
  );
  context.restore();
}

function drawPlane(
  context: CanvasRenderingContext2D, x: number, y: number, timeMs: number, scale = 1,
): void {
  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  context.fillStyle = PAPER;
  context.strokeStyle = INK;
  context.lineWidth = 3;
  // Fuselage.
  context.beginPath();
  context.moveTo(-150, 0);
  context.quadraticCurveTo(-120, -26, -20, -28);
  context.lineTo(90, -26);
  context.quadraticCurveTo(140, -22, 156, 0);
  context.quadraticCurveTo(120, 14, -20, 14);
  context.lineTo(-120, 12);
  context.closePath();
  context.fill();
  context.stroke();
  // Tail.
  context.beginPath();
  context.moveTo(-150, 0);
  context.lineTo(-138, -64);
  context.lineTo(-96, -26);
  context.closePath();
  context.fill();
  context.stroke();
  // Wing.
  context.beginPath();
  context.moveTo(10, 4);
  context.lineTo(-56, 42);
  context.lineTo(24, 42);
  context.lineTo(62, 6);
  context.closePath();
  context.fillStyle = "#c3cbb0";
  context.fill();
  context.stroke();
  // Windows and a blinking beacon.
  context.fillStyle = SIGNAL;
  for (let i = 0; i < 8; i++) context.fillRect(-4 + i * 18, -16, 9, 8);
  context.beginPath();
  context.arc(150, -4, 5, 0, Math.PI * 2);
  context.fillStyle = timeMs === 0 || Math.floor(timeMs / 420) % 2 ? ALERT : "#6b735a";
  context.fill();
  context.stroke();
  context.restore();
}

function drawEscapeAgent(
  context: CanvasRenderingContext2D, x: number, y: number,
  sprites: GenerationSprites | "loading" | "error" | undefined,
  timeMs: number, reducedMotion: boolean,
): void {
  if (!sprites || sprites === "loading" || sprites === "error") return;
  const frameIndex = reducedMotion ? 0 : Math.floor(timeMs / 90) % 8;
  const rows = spriteFrame(sprites, "right", true, frameIndex, "right").frame.rows;
  const left = Math.round(x) - 40;
  const top = Math.round(y) - 75;
  const pixels: [number, number][] = [];
  rows.forEach((row, py) => [...row].forEach((pixel, px) => { if (pixel === "#") pixels.push([px, py]); }));
  context.save();
  context.beginPath();
  context.rect(left, top, 80, 80);
  context.clip();
  context.fillStyle = "#fff";
  for (const [px, py] of pixels) context.fillRect(left + px * 5 - 5, top + py * 5 - 5, 15, 15);
  context.fillStyle = "#000";
  for (const [px, py] of pixels) context.fillRect(left + px * 5, top + py * 5, 5, 5);
  context.restore();
}
