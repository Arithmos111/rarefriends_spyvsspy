/**
 * Builds the room-scoped view of a match that one player is allowed to see.
 *
 * The relay sends this over the wire; the training run builds the same thing locally against
 * a sim it steps itself. Keeping one implementation means a lesson can never teach something
 * the real game does not do, and the fog-of-war rules (you see your own room, your own traps,
 * and other traps only with a detector) are enforced in exactly one place.
 */
import {
  canonicalDoorTrapId, isDoorTrapId,
  type MatchSnapshot, type PublicPlayer, type RoomTrap,
} from "./protocol.ts";
import { scoreOf, type MatchSim, type SimPlayer } from "./sim.ts";

export function scoreboardOf(sim: MatchSim): PublicPlayer[] {
  return [...sim.players.values()]
    .map(player => ({
      playerId: player.playerId, codename: player.codename, friendId: player.friendId,
      genesis: player.genesis, friendName: player.friendName,
      items: player.inventory.length, deaths: player.deaths, takedowns: player.takedowns,
      connected: player.connected, hasKnife: player.knife, score: scoreOf(sim, player),
    }))
    .sort((a, b) => b.score - a.score || b.items - a.items || a.deaths - b.deaths);
}

function actorOf(sim: MatchSim, player: SimPlayer) {
  return {
    playerId: player.playerId, friendId: player.friendId, codename: player.codename,
    genesis: player.genesis, friendName: player.friendName,
    x: Math.round(player.x * 10) / 10, y: Math.round(player.y * 10) / 10,
    facing: player.facing, walking: player.walking,
    hp: player.hp, maxHp: player.maxHp, hasKnife: player.knife,
    stunnedMs: Math.max(0, player.stunnedUntil - sim.now),
    attackingMs: Math.max(0, player.attackingUntil - sim.now),
    invulnerableMs: Math.max(0, player.invulnerableUntil - sim.now),
    busy: player.busy ? {
      kind: player.busy.kind, targetId: player.busy.targetId,
      progress: Math.min(1, (sim.now - player.busy.startedAt)
        / Math.max(1, player.busy.endsAt - player.busy.startedAt)),
    } : null,
  };
}

export function buildSnapshot(sim: MatchSim, playerId: string): MatchSnapshot {
  const self = sim.players.get(playerId)!;
  const room = sim.map.rooms[self.room];

  // Only traps this viewer set, or can see with a detector.
  const traps: RoomTrap[] = [];
  for (const trap of sim.traps.values()) {
    if (isDoorTrapId(trap.targetId)) continue;
    if (Math.floor(trap.targetId / 100) !== self.room) continue;
    const mine = trap.ownerId === playerId;
    if (!mine && !self.detector) continue;
    traps.push({ targetId: trap.targetId, type: trap.type, mine, direction: null });
  }
  // Doorway traps are keyed to the opening, which belongs to two rooms. Walk this room's own
  // doors so a trap is seen, and marked on the right wall, from whichever side you stand.
  for (const direction of room.doors) {
    const trap = sim.traps.get(canonicalDoorTrapId(self.room, direction));
    if (!trap) continue;
    const mine = trap.ownerId === playerId;
    if (!mine && !self.detector) continue;
    traps.push({ targetId: trap.targetId, type: trap.type, mine, direction });
  }

  return {
    t: "snapshot", tick: sim.tick, ackSeq: self.lastSeq,
    secondsLeft: Math.max(0, Math.round((sim.endsAt - sim.now) / 1000)),
    roomIndex: self.room, roomName: room.name, doors: room.doors,
    exitHere: self.room === sim.map.exitRoom,
    self: {
      ...actorOf(sim, self),
      inventory: [...self.inventory],
      powerUps: [...self.powerUps],
      traps: { ...self.traps },
      hasDetector: self.detector, hasLockpick: self.lockpick, hasDisarm: self.disarm,
      respawnMs: Math.max(0, self.respawnAt ? self.respawnAt - sim.now : 0),
    },
    actors: [...sim.players.values()]
      .filter(player => player.playerId !== playerId && player.room === self.room
        && player.respawnAt === 0)
      .map(player => actorOf(sim, player)),
    furniture: room.furniture.map(piece => ({
      id: piece.id, type: piece.type, x: piece.x, y: piece.y, slot: piece.slot,
      searched: piece.searched, emptied: piece.emptied,
    })),
    traps,
    drops: sim.drops.filter(drop => drop.room === self.room)
      .map(drop => ({ id: drop.id, item: drop.item, x: drop.x, y: drop.y })),
    // Room-scoped like everything else, and sent as an age so no clock sync is needed.
    effects: sim.effects.filter(entry => entry.room === self.room)
      .map(entry => ({ id: entry.id, kind: entry.kind, x: entry.x, y: entry.y,
        ageMs: Math.max(0, sim.now - entry.bornAt) })),
    scoreboard: scoreboardOf(sim),
  };
}
