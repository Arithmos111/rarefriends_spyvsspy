/**
 * Deterministic embassy generation. The server picks a seed and sends it once; both sides
 * build byte-identical furniture layouts from it, so the client can draw and predict
 * against the same collision geometry the server enforces.
 *
 * Item placement is generated on the server only. The client receives a map with empty
 * contents and learns what a piece of furniture held when the server tells it.
 */
import {
  DECOR_TYPES, FURNITURE_FOOTPRINT, FURNITURE_TYPES, GRID_W, MISSION_ITEMS, PLAYER_RADIUS,
  ROOM_COUNT, ROOM_H, ROOM_NAMES, ROOM_W, roomDoors,
  type Carryable, type DecorType, type Direction, type FurnitureType, type RoomDecor,
} from "./protocol.ts";

/** Room 4 is the centre of the 3x3 block, equidistant from all four corner spawns. */
export const EXIT_ROOM = 4;
export const EXIT_X = ROOM_W / 2;
export const EXIT_Y = ROOM_H / 2;
export const EXIT_RADIUS = 54;

/** Corner rooms, so no agent starts closer to the gate than another. */
export const SPAWN_ROOMS: readonly number[] = Object.freeze([0, 2, 6, 8]);

export type Furniture = {
  id: number; slot: number; type: FurnitureType; x: number; y: number;
  contents: Carryable | null; searched: boolean; emptied: boolean;
};
export type Room = {
  index: number; name: string; doors: readonly Direction[];
  furniture: Furniture[]; decor: readonly RoomDecor[];
};
export type EmbassyMap = { seed: number; rooms: Room[]; exitRoom: number };

/** mulberry32 — small, fast and identical across engines. */
export function createRandom(seed: number) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Candidate furniture anchors. Every slot clears the four doorways and the centre of the
 * floor, so a generated room is always fully walkable.
 */
const SLOTS: readonly (readonly [number, number])[] = Object.freeze([
  [84, 58], [436, 58], [84, 302], [436, 302],
  [174, 50], [346, 50], [174, 310], [346, 310],
  [52, 96], [52, 264], [468, 96], [468, 264],
]);

/**
 * Decorative anchors. Wall pieces hang along the two far edges; floor pieces sit in open
 * ground. None of these collide, so they can go anywhere the eye wants them.
 */
const WALL_SPOTS: readonly (readonly [number, number])[] = Object.freeze([
  [120, 0], [260, 0], [400, 0], [0, 110], [0, 250],
]);
const FLOOR_SPOTS: readonly (readonly [number, number])[] = Object.freeze([
  [260, 200], [150, 240], [370, 240], [260, 300],
]);
const WALL_DECOR: readonly DecorType[] = Object.freeze(["portrait", "banner", "clock", "flag"]);
const FLOOR_DECOR: readonly DecorType[] = Object.freeze(["rug", "lamp", "bookshelf"]);

function decorFor(random: () => number): RoomDecor[] {
  const decor: RoomDecor[] = [];
  const wallOrder = WALL_SPOTS.map((_, index) => index);
  for (let i = wallOrder.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [wallOrder[i], wallOrder[j]] = [wallOrder[j], wallOrder[i]];
  }
  for (const slot of wallOrder.slice(0, 2 + Math.floor(random() * 2))) {
    const [x, y] = WALL_SPOTS[slot];
    decor.push({ type: WALL_DECOR[Math.floor(random() * WALL_DECOR.length)], x, y, variant: Math.floor(random() * 4) });
  }
  const floorOrder = FLOOR_SPOTS.map((_, index) => index);
  for (let i = floorOrder.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [floorOrder[i], floorOrder[j]] = [floorOrder[j], floorOrder[i]];
  }
  for (const slot of floorOrder.slice(0, 1 + Math.floor(random() * 2))) {
    const [x, y] = FLOOR_SPOTS[slot];
    decor.push({ type: FLOOR_DECOR[Math.floor(random() * FLOOR_DECOR.length)], x, y, variant: Math.floor(random() * 4) });
  }
  return decor;
}

export function createMap(seed: number): EmbassyMap {
  const random = createRandom(seed);
  const rooms: Room[] = [];
  for (let index = 0; index < ROOM_COUNT; index++) {
    const order = SLOTS.map((_, slot) => slot);
    // Fisher-Yates with the shared generator keeps both sides in step.
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const count = 5;
    const furniture: Furniture[] = order.slice(0, count).map(slot => {
      const type = FURNITURE_TYPES[Math.floor(random() * FURNITURE_TYPES.length)];
      const [x, y] = SLOTS[slot];
      return { id: index * 100 + slot, slot, type, x, y, contents: null, searched: false, emptied: false };
    }).sort((a, b) => a.id - b.id);
    rooms.push({
      index, name: ROOM_NAMES[index] ?? `Room ${index + 1}`, doors: roomDoors(index),
      furniture, decor: Object.freeze(decorFor(random)),
    });
  }
  return { seed, rooms, exitRoom: EXIT_ROOM };
}

/**
 * Server-side only. Hides the four mission items in four distinct non-exit rooms, then
 * scatters power-ups through whatever furniture is still empty. Exactly one knife exists.
 */
export function placeMissionItems(map: EmbassyMap, seed: number): void {
  const random = createRandom(seed ^ 0x9e3779b9);
  const shuffle = <T,>(values: T[]) => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };

  const candidates = shuffle(map.rooms.map(room => room.index).filter(index => index !== map.exitRoom));
  MISSION_ITEMS.forEach((item, position) => {
    const room = map.rooms[candidates[position]];
    const choice = room.furniture[Math.floor(random() * room.furniture.length)];
    choice.contents = item;
  });

  // One knife, two vests and three medkits, spread over the furniture nothing else claimed.
  const free = shuffle(map.rooms.flatMap(room => room.furniture.filter(piece => piece.contents === null)));
  const loot: Carryable[] = ["knife", "vest", "vest", "medkit", "medkit", "medkit"];
  loot.forEach((item, index) => {
    const piece = free[index];
    if (piece) piece.contents = item;
  });
}

export function findFurniture(map: EmbassyMap, furnitureId: number): Furniture | null {
  const room = map.rooms[Math.floor(furnitureId / 100)];
  return room?.furniture.find(piece => piece.id === furnitureId) ?? null;
}

/** True when a circle of PLAYER_RADIUS at (x, y) overlaps furniture in this room. */
export function blockedByFurniture(room: Room, x: number, y: number, radius = PLAYER_RADIUS): boolean {
  for (const piece of room.furniture) {
    const { w, h } = FURNITURE_FOOTPRINT[piece.type];
    const nearestX = Math.max(piece.x - w / 2, Math.min(x, piece.x + w / 2));
    const nearestY = Math.max(piece.y - h / 2, Math.min(y, piece.y + h / 2));
    if ((x - nearestX) ** 2 + (y - nearestY) ** 2 < radius * radius) return true;
  }
  return false;
}

export function insideRoom(x: number, y: number, radius = PLAYER_RADIUS): boolean {
  return x >= radius && x <= ROOM_W - radius && y >= radius && y <= ROOM_H - radius;
}

/** Where an agent arrives after travelling through a door in the given direction. */
export function doorEntryPoint(direction: Direction): { x: number; y: number } {
  const inset = PLAYER_RADIUS + 16;
  if (direction === "north") return { x: ROOM_W / 2, y: ROOM_H - inset };
  if (direction === "south") return { x: ROOM_W / 2, y: inset };
  if (direction === "west") return { x: ROOM_W - inset, y: ROOM_H / 2 };
  return { x: inset, y: ROOM_H / 2 };
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === "north" ? "south" : direction === "south" ? "north"
    : direction === "west" ? "east" : "west";
}

export function spawnPointFor(seatIndex: number): { room: number; x: number; y: number } {
  const room = SPAWN_ROOMS[seatIndex % SPAWN_ROOMS.length];
  const rx = room % GRID_W;
  // Nudge away from the wall the corner sits against so a spawn never clips furniture.
  return { room, x: rx === 0 ? 150 : rx === GRID_W - 1 ? ROOM_W - 150 : ROOM_W / 2, y: ROOM_H / 2 };
}
