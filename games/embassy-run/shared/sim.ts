/**
 * Authoritative match simulation.
 *
 * The server owns one instance per match and steps it at TICK_HZ. The browser runs the
 * same movement code against its own copy purely to predict the local agent between
 * snapshots; every rule that decides an outcome (searching, traps, damage, escaping) is
 * resolved here on the server and only reported to clients.
 */
import {
  ATTACK_COOLDOWN_MS, ATTACK_RANGE, ATTACK_WINDUP_MS, BUCKET_STUN_MS, DISARM_MS,
  DOOR_HALF_WIDTH, HIT_STUN_MS, INTERACT_RANGE, MATCH_SECONDS, MAX_STEP_MS, MISSION_ITEMS,
  MISSION_ITEM_LABELS, PLANT_MS, PLAYER_MAX_HP, PLAYER_RADIUS, PLAYER_SPEED, RESPAWN_MS,
  ROOM_H, ROOM_W, SEARCH_MS, SEARCH_MS_LOCKPICK, SPAWN_INVULNERABLE_MS, TRAP_IS_LETHAL,
  TRAP_LABELS, TRAP_TYPES, neighbourRoom,
  type Direction, type MatchEvent, type MissionItem, type PlayerAction, type TrapType,
} from "./protocol.ts";
import {
  EXIT_RADIUS, EXIT_X, EXIT_Y, blockedByFurniture, createMap, doorEntryPoint, findFurniture,
  insideRoom, placeMissionItems, spawnPointFor, type EmbassyMap,
} from "./mansion.ts";
import { kitById, resolveTraps } from "./loadouts.ts";

export type Facing = "up" | "down" | "left" | "right";

export type SimPlayer = {
  playerId: string; friendId: string; codename: string; genesis: boolean; seat: number;
  room: number; x: number; y: number; facing: Facing; walking: boolean;
  hp: number; deaths: number; connected: boolean;
  stunnedUntil: number; attackReadyAt: number; attackingUntil: number;
  invulnerableUntil: number; respawnAt: number;
  inventory: MissionItem[]; traps: Record<TrapType, number>;
  detector: boolean; lockpick: boolean; disarm: boolean;
  busy: { kind: "search" | "plant" | "disarm"; furnitureId: number; startedAt: number; endsAt: number; trap?: TrapType } | null;
  input: { dx: number; dy: number }; lastSeq: number;
};

export type SimTrap = { furnitureId: number; type: TrapType; ownerId: string };
export type SimDrop = { id: number; item: MissionItem; room: number; x: number; y: number };

export type SimEvent = MatchEvent & { to?: string };

export type MatchSim = {
  seed: number; map: EmbassyMap;
  players: Map<string, SimPlayer>;
  traps: Map<number, SimTrap>;
  drops: SimDrop[]; nextDropId: number;
  now: number; endsAt: number; tick: number;
  finished: boolean; winner: string | null; endReason: string;
  events: SimEvent[];
};

const clamp = (value: number, low: number, high: number) => value < low ? low : value > high ? high : value;
const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function createMatch(
  seed: number,
  roster: readonly Readonly<{ playerId: string; friendId: string; codename: string; genesis: boolean; kitId: string }>[],
  now: number,
): MatchSim {
  const map = createMap(seed);
  placeMissionItems(map, seed);
  const players = new Map<string, SimPlayer>();
  roster.forEach((entry, seat) => {
    const spawn = spawnPointFor(seat);
    players.set(entry.playerId, {
      playerId: entry.playerId, friendId: entry.friendId, codename: entry.codename,
      genesis: entry.genesis, seat,
      room: spawn.room, x: spawn.x, y: spawn.y, facing: "down", walking: false,
      hp: PLAYER_MAX_HP, deaths: 0, connected: true,
      stunnedUntil: 0, attackReadyAt: 0, attackingUntil: 0,
      invulnerableUntil: now + SPAWN_INVULNERABLE_MS, respawnAt: 0,
      inventory: [], traps: resolveTraps(entry.kitId, entry.genesis),
      detector: kitFlag(entry.kitId, "detector"), lockpick: kitFlag(entry.kitId, "lockpick"),
      disarm: kitFlag(entry.kitId, "disarm"),
      busy: null, input: { dx: 0, dy: 0 }, lastSeq: 0,
    });
  });
  return {
    seed, map, players, traps: new Map(), drops: [], nextDropId: 1,
    now, endsAt: now + MATCH_SECONDS * 1000, tick: 0,
    finished: false, winner: null, endReason: "", events: [],
  };
}

function kitFlag(kitId: string, flag: "detector" | "lockpick" | "disarm"): boolean {
  return kitById(kitId)[flag];
}

function emit(sim: MatchSim, text: string, tone: MatchEvent["tone"], to?: string) {
  sim.events.push({ at: sim.now, text, tone, ...(to ? { to } : {}) });
  if (sim.events.length > 200) sim.events.splice(0, sim.events.length - 200);
}

export function isActive(player: SimPlayer, now: number): boolean {
  return player.hp > 0 && player.respawnAt === 0 && player.stunnedUntil <= now;
}

/** Movement, door transitions and collision. Shared verbatim with the client's prediction. */
export function movePlayer(
  map: EmbassyMap, player: Pick<SimPlayer, "room" | "x" | "y" | "facing" | "walking">,
  dx: number, dy: number, deltaMs: number,
): void {
  player.walking = false;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 0.01) return;
  const nx = dx / magnitude, ny = dy / magnitude;
  player.facing = Math.abs(nx) > Math.abs(ny) ? (nx < 0 ? "left" : "right") : (ny < 0 ? "up" : "down");
  const step = Math.min(MAX_STEP_MS, deltaMs) * PLAYER_SPEED / 1000;
  if (step <= 0) return;

  const targetX = player.x + nx * step;
  const targetY = player.y + ny * step;
  const room = map.rooms[player.room];

  const crossing = doorCrossing(room.doors, targetX, targetY);
  if (crossing) {
    const next = neighbourRoom(player.room, crossing);
    if (next !== null) {
      const entry = doorEntryPoint(crossing);
      player.room = next;
      player.x = entry.x;
      player.y = entry.y;
      player.walking = true;
      return;
    }
  }

  const tryMove = (x: number, y: number) => {
    if (!insideRoom(x, y)) return false;
    if (blockedByFurniture(map.rooms[player.room], x, y)) return false;
    player.x = x; player.y = y; player.walking = true;
    return true;
  };
  if (tryMove(targetX, targetY)) return;
  // Slide along whichever axis is still clear so walls never feel sticky.
  if (nx !== 0 && tryMove(targetX, player.y)) return;
  if (ny !== 0) tryMove(player.x, targetY);
}

function doorCrossing(doors: readonly Direction[], x: number, y: number): Direction | null {
  if (x < PLAYER_RADIUS && doors.includes("west") && Math.abs(y - ROOM_H / 2) <= DOOR_HALF_WIDTH) return "west";
  if (x > ROOM_W - PLAYER_RADIUS && doors.includes("east") && Math.abs(y - ROOM_H / 2) <= DOOR_HALF_WIDTH) return "east";
  if (y < PLAYER_RADIUS && doors.includes("north") && Math.abs(x - ROOM_W / 2) <= DOOR_HALF_WIDTH) return "north";
  if (y > ROOM_H - PLAYER_RADIUS && doors.includes("south") && Math.abs(x - ROOM_W / 2) <= DOOR_HALF_WIDTH) return "south";
  return null;
}

export function stepMatch(sim: MatchSim, deltaMs: number): void {
  if (sim.finished) return;
  sim.now += deltaMs;
  sim.tick++;

  for (const player of sim.players.values()) {
    if (player.respawnAt > 0) {
      if (sim.now >= player.respawnAt) respawn(sim, player);
      continue;
    }
    if (player.stunnedUntil > sim.now) { player.walking = false; continue; }
    if (player.busy) {
      if (sim.now >= player.busy.endsAt) completeBusy(sim, player);
      else player.walking = false;
      continue;
    }
    const before = player.room;
    movePlayer(sim.map, player, player.input.dx, player.input.dy, deltaMs);
    if (player.room !== before) cancelBusy(player);
  }

  if (!sim.finished && sim.now >= sim.endsAt) finishOnTime(sim);
}

function respawn(sim: MatchSim, player: SimPlayer): void {
  const spawn = spawnPointFor(player.seat);
  player.room = spawn.room; player.x = spawn.x; player.y = spawn.y;
  player.hp = PLAYER_MAX_HP; player.respawnAt = 0; player.stunnedUntil = 0;
  player.invulnerableUntil = sim.now + SPAWN_INVULNERABLE_MS;
  player.busy = null; player.walking = false; player.input = { dx: 0, dy: 0 };
}

function cancelBusy(player: SimPlayer): void { player.busy = null; }

export function applyInput(sim: MatchSim, playerId: string, seq: number, dx: number, dy: number): void {
  const player = sim.players.get(playerId);
  if (!player || sim.finished) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (seq <= player.lastSeq) return;
  player.lastSeq = seq;
  const magnitude = Math.hypot(dx, dy);
  // Never trust a client-supplied vector longer than one unit.
  player.input = magnitude > 1 ? { dx: dx / magnitude, dy: dy / magnitude } : { dx, dy };
}

export function applyAction(sim: MatchSim, playerId: string, action: PlayerAction): void {
  const player = sim.players.get(playerId);
  if (!player || sim.finished) return;
  if (action.kind === "cancel") { cancelBusy(player); return; }
  if (!isActive(player, sim.now)) return;

  switch (action.kind) {
    case "search": return beginSearch(sim, player, action.furnitureId);
    case "plant": return beginPlant(sim, player, action.furnitureId, action.trap);
    case "disarm": return beginDisarm(sim, player, action.furnitureId);
    case "pickup": return pickUp(sim, player, action.dropId);
    case "attack": return attack(sim, player);
    case "escape": return tryEscape(sim, player);
  }
}

function furnitureInReach(sim: MatchSim, player: SimPlayer, furnitureId: number) {
  if (Math.floor(furnitureId / 100) !== player.room) return null;
  const piece = findFurniture(sim.map, furnitureId);
  if (!piece) return null;
  if (distance(player.x, player.y, piece.x, piece.y) > INTERACT_RANGE) return null;
  return piece;
}

function beginSearch(sim: MatchSim, player: SimPlayer, furnitureId: number): void {
  if (player.busy) return;
  const piece = furnitureInReach(sim, player, furnitureId);
  if (!piece) return;
  const duration = player.lockpick ? SEARCH_MS_LOCKPICK : SEARCH_MS;
  player.busy = { kind: "search", furnitureId, startedAt: sim.now, endsAt: sim.now + duration };
}

function beginPlant(sim: MatchSim, player: SimPlayer, furnitureId: number, trap: TrapType): void {
  if (player.busy || !TRAP_TYPES.includes(trap)) return;
  if ((player.traps[trap] ?? 0) <= 0) return;
  const piece = furnitureInReach(sim, player, furnitureId);
  if (!piece || sim.traps.has(furnitureId)) return;
  player.busy = { kind: "plant", furnitureId, startedAt: sim.now, endsAt: sim.now + PLANT_MS, trap };
}

function beginDisarm(sim: MatchSim, player: SimPlayer, furnitureId: number): void {
  if (player.busy || !player.disarm) return;
  const piece = furnitureInReach(sim, player, furnitureId);
  if (!piece) return;
  const trap = sim.traps.get(furnitureId);
  if (!trap || trap.ownerId === player.playerId) return;
  player.busy = { kind: "disarm", furnitureId, startedAt: sim.now, endsAt: sim.now + DISARM_MS };
}

function completeBusy(sim: MatchSim, player: SimPlayer): void {
  const busy = player.busy;
  player.busy = null;
  if (!busy) return;
  const piece = findFurniture(sim.map, busy.furnitureId);
  if (!piece) return;

  if (busy.kind === "plant") {
    const trap = busy.trap!;
    if ((player.traps[trap] ?? 0) <= 0 || sim.traps.has(busy.furnitureId)) return;
    player.traps[trap]--;
    sim.traps.set(busy.furnitureId, { furnitureId: busy.furnitureId, type: trap, ownerId: player.playerId });
    emit(sim, `${TRAP_LABELS[trap]} set in the ${sim.map.rooms[player.room].name}.`, "good", player.playerId);
    return;
  }

  if (busy.kind === "disarm") {
    const trap = sim.traps.get(busy.furnitureId);
    if (!trap || trap.ownerId === player.playerId) return;
    sim.traps.delete(busy.furnitureId);
    player.traps[trap.type] = (player.traps[trap.type] ?? 0) + 1;
    emit(sim, `You disarmed a ${TRAP_LABELS[trap.type].toLowerCase()} and kept it.`, "good", player.playerId);
    const owner = sim.players.get(trap.ownerId);
    if (owner) emit(sim, `${player.codename} disarmed your ${TRAP_LABELS[trap.type].toLowerCase()}.`, "bad", owner.playerId);
    return;
  }

  // Search. A rival's trap fires before anything is found.
  const trap = sim.traps.get(busy.furnitureId);
  if (trap && trap.ownerId !== player.playerId) {
    sim.traps.delete(busy.furnitureId);
    triggerTrap(sim, player, trap);
    return;
  }
  piece.searched = true;
  if (piece.contents) {
    const item = piece.contents;
    piece.contents = null;
    piece.emptied = true;
    player.inventory.push(item);
    emit(sim, `${player.codename} recovered the ${MISSION_ITEM_LABELS[item].toLowerCase()}.`, "alert");
    emit(sim, `You found the ${MISSION_ITEM_LABELS[item].toLowerCase()}.`, "good", player.playerId);
  } else {
    piece.emptied = true;
    emit(sim, "Nothing hidden here.", "info", player.playerId);
  }
}

function triggerTrap(sim: MatchSim, victim: SimPlayer, trap: SimTrap): void {
  const owner = sim.players.get(trap.ownerId);
  const label = TRAP_LABELS[trap.type].toLowerCase();
  if (TRAP_IS_LETHAL[trap.type]) {
    emit(sim, `${victim.codename} set off a ${label}.`, "alert");
    if (owner) emit(sim, `Your ${label} caught ${victim.codename}.`, "good", owner.playerId);
    kill(sim, victim, `a ${label}`);
    return;
  }
  victim.stunnedUntil = sim.now + BUCKET_STUN_MS;
  victim.busy = null;
  emit(sim, `A ${label} soaked you. You cannot move for a moment.`, "bad", victim.playerId);
  if (owner) emit(sim, `Your ${label} slowed ${victim.codename} down.`, "good", owner.playerId);
}

function attack(sim: MatchSim, player: SimPlayer): void {
  if (sim.now < player.attackReadyAt || player.busy) return;
  player.attackReadyAt = sim.now + ATTACK_COOLDOWN_MS;
  player.attackingUntil = sim.now + ATTACK_WINDUP_MS;
  let best: SimPlayer | null = null;
  let bestDistance = ATTACK_RANGE;
  for (const other of sim.players.values()) {
    if (other.playerId === player.playerId || other.room !== player.room) continue;
    if (other.respawnAt > 0 || sim.now < other.invulnerableUntil) continue;
    const gap = distance(player.x, player.y, other.x, other.y);
    if (gap <= bestDistance) { best = other; bestDistance = gap; }
  }
  if (!best) return;
  best.hp -= 1;
  best.busy = null;
  best.stunnedUntil = sim.now + HIT_STUN_MS;
  if (best.hp <= 0) {
    emit(sim, `${player.codename} took down ${best.codename}.`, "alert");
    kill(sim, best, `${player.codename}`);
  } else {
    emit(sim, `${player.codename} struck you.`, "bad", best.playerId);
    emit(sim, `You struck ${best.codename}.`, "good", player.playerId);
  }
}

function kill(sim: MatchSim, victim: SimPlayer, cause: string): void {
  const dropped = victim.inventory.splice(0, victim.inventory.length);
  dropped.forEach((item, index) => {
    const angle = (index / Math.max(1, dropped.length)) * Math.PI * 2;
    sim.drops.push({
      id: sim.nextDropId++, item, room: victim.room,
      x: clamp(victim.x + Math.cos(angle) * 34, PLAYER_RADIUS, ROOM_W - PLAYER_RADIUS),
      y: clamp(victim.y + Math.sin(angle) * 34, PLAYER_RADIUS, ROOM_H - PLAYER_RADIUS),
    });
  });
  victim.hp = 0;
  victim.deaths++;
  victim.busy = null;
  victim.walking = false;
  victim.input = { dx: 0, dy: 0 };
  victim.respawnAt = sim.now + RESPAWN_MS;
  emit(sim, `You were taken out by ${cause}.${dropped.length ? " You dropped everything you carried." : ""}`, "bad", victim.playerId);
}

function pickUp(sim: MatchSim, player: SimPlayer, dropId: number): void {
  const index = sim.drops.findIndex(drop => drop.id === dropId);
  if (index < 0) return;
  const drop = sim.drops[index];
  if (drop.room !== player.room) return;
  if (distance(player.x, player.y, drop.x, drop.y) > INTERACT_RANGE) return;
  sim.drops.splice(index, 1);
  player.inventory.push(drop.item);
  emit(sim, `You picked up the ${MISSION_ITEM_LABELS[drop.item].toLowerCase()}.`, "good", player.playerId);
}

function tryEscape(sim: MatchSim, player: SimPlayer): void {
  if (player.room !== sim.map.exitRoom) return;
  if (distance(player.x, player.y, EXIT_X, EXIT_Y) > EXIT_RADIUS) return;
  if (!hasFullSet(player)) {
    emit(sim, `The gate needs all ${MISSION_ITEMS.length} items. You have ${player.inventory.length}.`, "bad", player.playerId);
    return;
  }
  sim.finished = true;
  sim.winner = player.playerId;
  sim.endReason = `${player.codename} escaped through the courtyard gate with the full set.`;
  emit(sim, sim.endReason, "alert");
}

export function hasFullSet(player: SimPlayer): boolean {
  return MISSION_ITEMS.every(item => player.inventory.includes(item));
}

function finishOnTime(sim: MatchSim): void {
  sim.finished = true;
  const ranked = [...sim.players.values()].sort((a, b) =>
    b.inventory.length - a.inventory.length || a.deaths - b.deaths);
  const top = ranked[0];
  const tied = ranked.filter(player => player.inventory.length === top?.inventory.length && player.deaths === top?.deaths);
  if (top && top.inventory.length > 0 && tied.length === 1) {
    sim.winner = top.playerId;
    sim.endReason = `Time expired. ${top.codename} held the most intelligence.`;
  } else {
    sim.winner = null;
    sim.endReason = "Time expired with no agent clear of the embassy.";
  }
  emit(sim, sim.endReason, "alert");
}

/** Forfeit handling when an agent disconnects mid-match. */
export function dropPlayer(sim: MatchSim, playerId: string): void {
  const player = sim.players.get(playerId);
  if (!player) return;
  player.connected = false;
  player.input = { dx: 0, dy: 0 };
  player.busy = null;
  emit(sim, `${player.codename} lost contact with the embassy.`, "info");
  const remaining = [...sim.players.values()].filter(entry => entry.connected);
  if (!sim.finished && remaining.length === 0) {
    sim.finished = true;
    sim.winner = null;
    sim.endReason = "Every agent disconnected.";
  }
}
