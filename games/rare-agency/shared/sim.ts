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
  DOOR_HALF_WIDTH, EFFECT_DURATION_MS, FIST_DAMAGE, HIT_STUN_MS, INTERACT_RANGE, KNIFE_DAMAGE,
  MATCH_SECONDS,
  MAX_STEP_MS, MEDKIT_HEAL, MISSION_ITEMS, PLANT_MS, PLAYER_HP_CEILING, PLAYER_MAX_HP,
  PLAYER_RADIUS, PLAYER_SPEED, RESPAWN_MS, ROOM_H, ROOM_W, SCORE_ESCAPE, SCORE_PER_ITEM,
  SCORE_PER_TAKEDOWN, SCORE_SURVIVED, SCORE_TIME_WIN, SEARCH_MS, SEARCH_MS_LOCKPICK,
  SPAWN_INVULNERABLE_MS, TRAP_IS_LETHAL, TRAP_LABELS, TRAP_TYPES, VEST_BONUS_HP,
  canonicalDoorTrapId, carryableLabel, doorTrapDirection, isDoorTrapId, isPowerUp,
  neighbourRoom,
  type Carryable, type Direction, type EffectKind, type MatchCue, type MatchEvent,
  type MissionItem,
  type PlayerAction, type PowerUp, type TrapType,
} from "./protocol.ts";
import {
  EXIT_RADIUS, EXIT_X, EXIT_Y, blockedByFurniture, createMap, doorEntryPoint, findFurniture,
  insideRoom, placeMissionItems, spawnPointFor, type EmbassyMap,
} from "./mansion.ts";
import { kitById, resolveTraps } from "./loadouts.ts";

export type Facing = "up" | "down" | "left" | "right";

export type SimPlayer = {
  playerId: string; friendId: string; codename: string; genesis: boolean; seat: number;
  friendName: string | null;
  room: number; x: number; y: number; facing: Facing; walking: boolean;
  hp: number; maxHp: number; deaths: number; takedowns: number; connected: boolean;
  stunnedUntil: number; attackReadyAt: number; attackingUntil: number;
  invulnerableUntil: number; respawnAt: number;
  inventory: MissionItem[]; powerUps: PowerUp[]; traps: Record<TrapType, number>;
  detector: boolean; lockpick: boolean; disarm: boolean; knife: boolean;
  busy: { kind: "search" | "plant" | "disarm"; targetId: number; startedAt: number; endsAt: number; trap?: TrapType } | null;
  input: { dx: number; dy: number }; lastSeq: number;
  /** Doorway trap this agent has already been moved through, so it fires once per crossing. */
  itemsFound: number;
  /** Running tallies kept only for the end-of-match recap; nothing in the rules reads them. */
  stats: { hits: number; damageDealt: number; damageTaken: number; powerUpsTaken: number };
};

/** A trap on furniture or on a doorway; targetId distinguishes them. */
export type SimTrap = { targetId: number; type: TrapType; ownerId: string };
export type SimDrop = { id: number; item: Carryable; room: number; x: number; y: number };

/** A trap detonation or a landed blow, kept only while its animation runs. */
export type SimEffect = { id: number; kind: EffectKind; room: number; x: number; y: number; bornAt: number };

export type SimEvent = MatchEvent & { to?: string };
export type SimCue = MatchCue & { to: string };

export type MatchSim = {
  seed: number; map: EmbassyMap;
  players: Map<string, SimPlayer>;
  traps: Map<number, SimTrap>;
  drops: SimDrop[]; nextDropId: number;
  effects: SimEffect[]; nextEffectId: number;
  now: number; endsAt: number; tick: number;
  finished: boolean; winner: string | null; endReason: string;
  /** True when the winner reached the gate, which plays the escape sequence. */
  escaped: boolean;
  events: SimEvent[];
  cues: SimCue[];
};

const clamp = (value: number, low: number, high: number) => value < low ? low : value > high ? high : value;
const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function createMatch(
  seed: number,
  roster: readonly Readonly<{
    playerId: string; friendId: string; codename: string; genesis: boolean; kitId: string;
    friendName?: string | null;
  }>[],
  now: number,
): MatchSim {
  const map = createMap(seed);
  placeMissionItems(map, seed);
  const players = new Map<string, SimPlayer>();
  roster.forEach((entry, seat) => {
    const spawn = spawnPointFor(seat);
    players.set(entry.playerId, {
      playerId: entry.playerId, friendId: entry.friendId, codename: entry.codename,
      genesis: entry.genesis, seat, friendName: entry.friendName ?? null,
      room: spawn.room, x: spawn.x, y: spawn.y, facing: "down", walking: false,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, deaths: 0, takedowns: 0, connected: true,
      stunnedUntil: 0, attackReadyAt: 0, attackingUntil: 0,
      invulnerableUntil: now + SPAWN_INVULNERABLE_MS, respawnAt: 0,
      inventory: [], powerUps: [], traps: resolveTraps(entry.kitId, entry.genesis),
      detector: kitFlag(entry.kitId, "detector"), lockpick: kitFlag(entry.kitId, "lockpick"),
      disarm: kitFlag(entry.kitId, "disarm"), knife: false,
      busy: null, input: { dx: 0, dy: 0 }, lastSeq: 0, itemsFound: 0,
      stats: { hits: 0, damageDealt: 0, damageTaken: 0, powerUpsTaken: 0 },
    });
  });
  return {
    seed, map, players, traps: new Map(), drops: [], nextDropId: 1,
    effects: [], nextEffectId: 1,
    now, endsAt: now + MATCH_SECONDS * 1000, tick: 0,
    finished: false, winner: null, endReason: "", escaped: false, events: [], cues: [],
  };
}

function kitFlag(kitId: string, flag: "detector" | "lockpick" | "disarm"): boolean {
  return kitById(kitId)[flag];
}

function emit(sim: MatchSim, text: string, tone: MatchEvent["tone"], to?: string) {
  sim.events.push({ at: sim.now, text, tone, ...(to ? { to } : {}) });
  if (sim.events.length > 200) sim.events.splice(0, sim.events.length - 200);
}

/** A one-shot presentation cue for a single player, such as the centre-screen pickup flash. */
function cue(sim: MatchSim, to: string, value: MatchCue) {
  sim.cues.push({ ...value, to });
  if (sim.cues.length > 120) sim.cues.splice(0, sim.cues.length - 120);
}

/** Spawn a world effect. Pruned by age in step(), so nothing accumulates across a match. */
function effect(sim: MatchSim, kind: EffectKind, room: number, x: number, y: number): void {
  sim.effects.push({ id: sim.nextEffectId++, kind, room, x, y, bornAt: sim.now });
}

export function attackDamage(player: SimPlayer): number {
  return player.knife ? KNIFE_DAMAGE : FIST_DAMAGE;
}

/** Match points, recomputed from the running tallies rather than accumulated. */
export function scoreOf(sim: MatchSim, player: SimPlayer): number {
  let points = player.itemsFound * SCORE_PER_ITEM + player.takedowns * SCORE_PER_TAKEDOWN;
  if (sim.finished && sim.winner === player.playerId) points += sim.escaped ? SCORE_ESCAPE : SCORE_TIME_WIN;
  if (sim.finished && player.hp > 0 && player.respawnAt === 0) points += SCORE_SURVIVED;
  return points;
}

export function isActive(player: SimPlayer, now: number): boolean {
  return player.hp > 0 && player.respawnAt === 0 && player.stunnedUntil <= now;
}

/**
 * Set by movePlayer when a doorway is crossed, so the server can spring a door trap. The
 * client runs the same movement code for prediction and simply ignores this.
 */
let lastCrossing: { from: number; direction: Direction } | null = null;
export function takeLastCrossing() {
  const value = lastCrossing;
  lastCrossing = null;
  return value;
}

/** Movement, door transitions and collision. Shared verbatim with the client's prediction. */
export function movePlayer(
  map: EmbassyMap, player: Pick<SimPlayer, "room" | "x" | "y" | "facing" | "walking">,
  dx: number, dy: number, deltaMs: number,
): void {
  lastCrossing = null;
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
      lastCrossing = { from: player.room, direction: crossing };
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

  // Effects are presentation only; drop them once their animation has run out.
  if (sim.effects.length) {
    sim.effects = sim.effects.filter(entry => sim.now - entry.bornAt < EFFECT_DURATION_MS[entry.kind]);
  }

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
    if (player.room !== before) {
      cancelBusy(player);
      const crossing = takeLastCrossing();
      if (crossing) {
        const trap = sim.traps.get(canonicalDoorTrapId(crossing.from, crossing.direction));
        if (trap) {
          sim.traps.delete(trap.targetId);
          triggerTrap(sim, player, trap);
        }
      }
    }
  }

  if (!sim.finished && sim.now >= sim.endsAt) finishOnTime(sim);
}

function respawn(sim: MatchSim, player: SimPlayer): void {
  const spawn = spawnPointFor(player.seat);
  player.room = spawn.room; player.x = spawn.x; player.y = spawn.y;
  player.hp = player.maxHp; player.respawnAt = 0; player.stunnedUntil = 0;
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
    case "plant": return beginPlant(sim, player, action.targetId, action.trap);
    case "disarm": return beginDisarm(sim, player, action.targetId);
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

/** Where a doorway sits in its own room's coordinates, for reach checks and drawing. */
export function doorAnchor(direction: Direction): { x: number; y: number } {
  if (direction === "north") return { x: ROOM_W / 2, y: 0 };
  if (direction === "south") return { x: ROOM_W / 2, y: ROOM_H };
  if (direction === "west") return { x: 0, y: ROOM_H / 2 };
  return { x: ROOM_W, y: ROOM_H / 2 };
}

/** True when the agent is standing close enough to a trap target, furniture or doorway. */
/**
 * The doorway of this player's room that a target id refers to, from either side, or null.
 *
 * A doorway trap is keyed to the opening rather than to one room's description of it, so a
 * player standing on the far side names it by their own wall. Both resolve here.
 */
function doorwayOf(sim: MatchSim, player: SimPlayer, targetId: number): Direction | null {
  if (!isDoorTrapId(targetId)) return null;
  for (const direction of sim.map.rooms[player.room].doors) {
    if (canonicalDoorTrapId(player.room, direction) === targetId) return direction;
  }
  return null;
}

function targetInReach(sim: MatchSim, player: SimPlayer, targetId: number): boolean {
  if (isDoorTrapId(targetId)) {
    const direction = doorwayOf(sim, player, targetId);
    if (!direction) return false;
    const anchor = doorAnchor(direction);
    return distance(player.x, player.y, anchor.x, anchor.y) <= INTERACT_RANGE;
  }
  if (Math.floor(targetId / 100) !== player.room) return false;
  return furnitureInReach(sim, player, targetId) !== null;
}

function targetLabel(targetId: number): string {
  return isDoorTrapId(targetId) ? `${doorTrapDirection(targetId)} doorway` : "furniture";
}

/** Normalise a client-supplied door target to the doorway's own id. */
function canonicalTarget(sim: MatchSim, player: SimPlayer, targetId: number): number {
  if (!isDoorTrapId(targetId)) return targetId;
  const direction = doorwayOf(sim, player, targetId);
  return direction ? canonicalDoorTrapId(player.room, direction) : targetId;
}

function beginSearch(sim: MatchSim, player: SimPlayer, furnitureId: number): void {
  if (player.busy) return;
  const piece = furnitureInReach(sim, player, furnitureId);
  if (!piece) return;
  const duration = player.lockpick ? SEARCH_MS_LOCKPICK : SEARCH_MS;
  player.busy = { kind: "search", targetId: furnitureId, startedAt: sim.now, endsAt: sim.now + duration };
}

function beginPlant(sim: MatchSim, player: SimPlayer, targetId: number, trap: TrapType): void {
  targetId = canonicalTarget(sim, player, targetId);
  if (player.busy || !TRAP_TYPES.includes(trap)) return;
  if ((player.traps[trap] ?? 0) <= 0) return;
  if (!targetInReach(sim, player, targetId) || sim.traps.has(targetId)) return;
  player.busy = { kind: "plant", targetId, startedAt: sim.now, endsAt: sim.now + PLANT_MS, trap };
}

/** Your own traps can be disarmed too, since they are now just as dangerous to you. */
function beginDisarm(sim: MatchSim, player: SimPlayer, targetId: number): void {
  targetId = canonicalTarget(sim, player, targetId);
  if (player.busy || !player.disarm) return;
  if (!targetInReach(sim, player, targetId)) return;
  if (!sim.traps.has(targetId)) return;
  player.busy = { kind: "disarm", targetId, startedAt: sim.now, endsAt: sim.now + DISARM_MS };
}

function completeBusy(sim: MatchSim, player: SimPlayer): void {
  const busy = player.busy;
  player.busy = null;
  if (!busy) return;

  if (busy.kind === "plant") {
    const trap = busy.trap!;
    if ((player.traps[trap] ?? 0) <= 0 || sim.traps.has(busy.targetId)) return;
    player.traps[trap]--;
    sim.traps.set(busy.targetId, { targetId: busy.targetId, type: trap, ownerId: player.playerId });
    emit(sim, `${TRAP_LABELS[trap]} set on the ${targetLabel(busy.targetId)} in the ${sim.map.rooms[player.room].name}. Mind it yourself.`, "good", player.playerId);
    return;
  }

  if (busy.kind === "disarm") {
    const trap = sim.traps.get(busy.targetId);
    if (!trap) return;
    sim.traps.delete(busy.targetId);
    player.traps[trap.type] = (player.traps[trap.type] ?? 0) + 1;
    const own = trap.ownerId === player.playerId;
    emit(sim, own
      ? `You recovered your own ${TRAP_LABELS[trap.type].toLowerCase()}.`
      : `You disarmed a ${TRAP_LABELS[trap.type].toLowerCase()} and kept it.`, "good", player.playerId);
    if (!own) {
      const owner = sim.players.get(trap.ownerId);
      if (owner) emit(sim, `${player.codename} disarmed your ${TRAP_LABELS[trap.type].toLowerCase()}.`, "bad", owner.playerId);
    }
    return;
  }

  // Search. Any armed trap fires first, including one you set yourself.
  const piece = findFurniture(sim.map, busy.targetId);
  if (!piece) return;
  const trap = sim.traps.get(busy.targetId);
  if (trap) {
    sim.traps.delete(busy.targetId);
    triggerTrap(sim, player, trap);
    return;
  }
  piece.searched = true;
  if (piece.contents) {
    const item = piece.contents;
    piece.contents = null;
    piece.emptied = true;
    collect(sim, player, item);
  } else {
    piece.emptied = true;
    emit(sim, "Nothing hidden here.", "info", player.playerId);
  }
}

/** Take an item into inventory, or apply it immediately if it is a consumable power-up. */
function collect(sim: MatchSim, player: SimPlayer, item: Carryable): void {
  cue(sim, player.playerId, { kind: "pickup", item });
  if (isPowerUp(item)) player.stats.powerUpsTaken++;
  if (!isPowerUp(item)) {
    player.inventory.push(item);
    player.itemsFound++;
    emit(sim, `${player.codename} recovered the ${carryableLabel(item).toLowerCase()}.`, "alert");
    emit(sim, `You found the ${carryableLabel(item).toLowerCase()}. ${MISSION_ITEMS.length - player.inventory.length} to go.`, "good", player.playerId);
    return;
  }
  if (item === "medkit") {
    const healed = Math.min(MEDKIT_HEAL, player.maxHp - player.hp);
    player.hp += healed;
    if (healed > 0) cue(sim, player.playerId, { kind: "heal", amount: healed });
    emit(sim, healed > 0 ? `Field medkit: +${healed} health.` : "Field medkit found, but you are unhurt.", "good", player.playerId);
    if (healed === 0) player.powerUps.push(item);
    return;
  }
  if (item === "vest") {
    player.maxHp = Math.min(PLAYER_HP_CEILING, player.maxHp + VEST_BONUS_HP);
    player.hp = Math.min(player.maxHp, player.hp + VEST_BONUS_HP);
    player.powerUps.push(item);
    cue(sim, player.playerId, { kind: "heal", amount: VEST_BONUS_HP });
    emit(sim, `Ballistic vest: maximum health is now ${player.maxHp}.`, "good", player.playerId);
    return;
  }
  player.knife = true;
  player.powerUps.push(item);
  emit(sim, "You found the stiletto. Your strikes now hit for 2.", "good", player.playerId);
  emit(sim, `${player.codename} picked up the stiletto knife.`, "alert");
}

function triggerTrap(sim: MatchSim, victim: SimPlayer, trap: SimTrap): void {
  const owner = sim.players.get(trap.ownerId);
  const ownGoal = trap.ownerId === victim.playerId;
  const label = TRAP_LABELS[trap.type].toLowerCase();
  cue(sim, victim.playerId, { kind: "trap", trap: trap.type });
  effect(sim, trap.type, victim.room, victim.x, victim.y);
  // The owner hears their own trap spring, wherever they are standing.
  if (owner && !ownGoal) cue(sim, owner.playerId, { kind: "trap-sprung", trap: trap.type });
  if (TRAP_IS_LETHAL[trap.type]) {
    emit(sim, ownGoal
      ? `${victim.codename} was caught by their own ${label}.`
      : `${victim.codename} set off a ${label}.`, "alert");
    if (owner && !ownGoal) emit(sim, `Your ${label} caught ${victim.codename}.`, "good", owner.playerId);
    // A trap an agent set themselves is nobody's takedown.
    const fatal = Math.max(0, victim.hp);
    victim.stats.damageTaken += fatal;
    if (owner && !ownGoal) { owner.takedowns++; owner.stats.damageDealt += fatal; }
    kill(sim, victim, ownGoal ? `their own ${label}` : `a ${label}`);
    return;
  }
  victim.stunnedUntil = sim.now + BUCKET_STUN_MS;
  victim.busy = null;
  emit(sim, ownGoal
    ? `Your own ${label} soaked you. You cannot move for a moment.`
    : `A ${label} soaked you. You cannot move for a moment.`, "bad", victim.playerId);
  if (owner && !ownGoal) emit(sim, `Your ${label} slowed ${victim.codename} down.`, "good", owner.playerId);
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
  const damage = attackDamage(player);
  // Tallied at what the victim actually lost, so an overkill swing is not credited with
  // damage nobody had left to take.
  const applied = Math.min(damage, Math.max(0, best.hp));
  player.stats.hits++;
  player.stats.damageDealt += applied;
  best.stats.damageTaken += applied;
  best.hp -= damage;
  best.busy = null;
  best.stunnedUntil = sim.now + HIT_STUN_MS;
  cue(sim, best.playerId, { kind: "hurt", amount: damage });
  cue(sim, player.playerId, { kind: "hit", amount: damage });
  effect(sim, player.knife ? "slash" : "impact", best.room, best.x, best.y);
  // The number floats where the blow landed, so everyone in the room sees the trade.
  effect(sim, damage >= 2 ? "damage2" : "damage1", best.room, best.x, best.y);
  if (best.hp <= 0) {
    player.takedowns++;
    cue(sim, player.playerId, { kind: "takedown" });
    emit(sim, `${player.codename} took down ${best.codename}${player.knife ? " with the stiletto" : ""}.`, "alert");
    kill(sim, best, player.codename);
  } else {
    emit(sim, `${player.codename} struck you for ${damage}. ${best.hp} health left.`, "bad", best.playerId);
    emit(sim, `You struck ${best.codename} for ${damage}. ${best.hp} left.`, "good", player.playerId);
  }
}

function kill(sim: MatchSim, victim: SimPlayer, cause: string): void {
  const dropped: Carryable[] = victim.inventory.splice(0, victim.inventory.length);
  victim.itemsFound = Math.max(0, victim.itemsFound - dropped.length);
  if (victim.knife) {
    victim.knife = false;
    victim.powerUps = victim.powerUps.filter(entry => entry !== "knife");
    dropped.push("knife");
  }
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
  cue(sim, victim.playerId, { kind: "downed" });
  emit(sim, `You were taken out by ${cause}.${dropped.length ? " You dropped everything you carried." : ""}`, "bad", victim.playerId);
}

function pickUp(sim: MatchSim, player: SimPlayer, dropId: number): void {
  const index = sim.drops.findIndex(drop => drop.id === dropId);
  if (index < 0) return;
  const drop = sim.drops[index];
  if (drop.room !== player.room) return;
  if (distance(player.x, player.y, drop.x, drop.y) > INTERACT_RANGE) return;
  sim.drops.splice(index, 1);
  collect(sim, player, drop.item);
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
  sim.escaped = true;
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
    sim.escaped = false;
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
