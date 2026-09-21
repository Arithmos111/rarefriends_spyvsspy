/**
 * Renders one picture of every room in the mansion.
 *
 * This is a development harness, not part of the game: it drives the real renderer against a
 * real simulation so the pictures cannot drift from what players see. Nothing here is bundled
 * into the game, and it changes no production code path.
 */
import { createMatch } from "../games/rare-agency/shared/sim.ts";
import { buildSnapshot } from "../games/rare-agency/shared/view.ts";
import { placeMissionItems } from "../games/rare-agency/shared/mansion.ts";
import { ROOM_COUNT, ROOM_H, ROOM_W, TRAP_TYPES } from "../games/rare-agency/shared/protocol.ts";
import { drawEmbassy, drawEscapeScene, VIEW_H, VIEW_W } from "../games/rare-agency/render.ts";
import { createFriendReader } from "@rarefriends/friendsdk/sprites";

const SEED = 20260920;
const ME = "gallery";

declare global {
  interface Window {
    roomCount: number;
    roomName(index: number): string;
    renderRoom(index: number): Promise<void>;
    renderEscape(progress: number, won: boolean): Promise<void>;
  }
}

const canvas = document.createElement("canvas");
canvas.width = VIEW_W;
canvas.height = VIEW_H;
canvas.id = "stage";
document.body.append(canvas);
const context = canvas.getContext("2d")!;

const match = createMatch(SEED, [
  { playerId: ME, friendId: "7730", codename: "VIPER", genesis: false, kitId: "director" },
], 0);
placeMissionItems(match.map, SEED);

// A director's kit carries every trap and a detector, so the gallery can show a trapped
// doorway and a trapped cabinet marked the way a player carrying one would see them.
const me = match.players.get(ME)!;
const sprites = new Map<string, any>();
const reader = createFriendReader();

async function loadSprites(): Promise<void> {
  try {
    sprites.set(me.friendId, await reader.read(BigInt(me.friendId)));
  } catch (cause) {
    sprites.set(me.friendId, "error");
    (window as any).spriteError = String(cause instanceof Error ? cause.message : cause);
  }
}

window.roomCount = ROOM_COUNT;
window.roomName = index => match.map.rooms[index].name;

window.renderRoom = async index => {
  if (!sprites.has(me.friendId)) await loadSprites();
  const room = match.map.rooms[index];

  me.room = index;
  me.x = ROOM_W / 2;
  me.y = ROOM_H * 0.72;
  me.facing = "down";
  me.invulnerableUntil = 0;
  for (const type of TRAP_TYPES) me.traps[type] = 3;

  // Show the room as it plays: one piece already turned out, one trapped, and a trapped
  // doorway, so the markers and the "searched" state are visible in the gallery.
  match.traps.clear();
  room.furniture.forEach((piece, slot) => {
    piece.searched = slot === 1;
    piece.emptied = slot === 1;
  });
  if (room.furniture[2]) {
    match.traps.set(room.furniture[2].id, {
      targetId: room.furniture[2].id, type: "bomb", ownerId: ME,
    });
  }

  const snapshot = buildSnapshot(match, ME);
  drawEmbassy(context, {
    snapshot,
    selfX: me.x, selfY: me.y,
    sprites,
    decor: room.decor,
    nearestFurnitureId: room.furniture[0]?.id ?? null,
    nearestDropId: null,
    nearestDoor: null,
    effects: [],
    reducedMotion: true,
    timeMs: 1200,
  });
};

/** The winning sequence, sampled at a given point along its run. */
window.renderEscape = async (progress, won) => {
  if (!sprites.has(me.friendId)) await loadSprites();
  drawEscapeScene(context, {
    progress,
    codename: me.codename,
    friendName: null,
    sprites: sprites.get(me.friendId),
    // Not reduced: reduced motion deliberately holds one frame, which would make every
    // sample in the gallery identical.
    reducedMotion: false,
    timeMs: 1000 + progress * 6200,
    won,
  });
};
