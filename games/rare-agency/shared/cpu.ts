/**
 * The CPU agent.
 *
 * Demo mode runs a real match in the browser with the real rules, and fills the other seats
 * with these. The brain is deliberately plain: a small memory of what this agent has seen,
 * a handful of candidate goals scored against each other every so often, and a route to
 * whichever wins. There is no search tree and no learning, because the interesting part of
 * this game is hidden information rather than tactical depth, and an opponent that behaves
 * legibly is more fun to practise against than one that is merely hard.
 *
 * Three rules are load-bearing:
 *
 * 1. **It cheats at nothing.** Everything it knows, it knows from having stood in the room.
 *    Rooms it has not visited hold no information for it, rivals it cannot see are only
 *    remembered where it last saw them, and rival traps are invisible to it exactly as they
 *    are to a player without a detector. It walks into them.
 * 2. **It plays through the same doors as everyone else.** Input is a unit vector into
 *    `applyInput`, actions go through `applyAction`, and the simulation decides what happens.
 *    Nothing here reaches past the public surface a human player's client uses.
 * 3. **Difficulty is reaction and recall, never statistics.** A rookie thinks slowly and
 *    forgets where it has searched; a veteran thinks quickly and remembers. Neither hits
 *    harder, moves faster or sees further than you do.
 */
import {
  ATTACK_RANGE, DIRECTIONS, INTERACT_RANGE, MISSION_ITEMS, PLAYER_RADIUS,
  ROOM_H, ROOM_W, TRAP_TYPES, canonicalDoorTrapId, neighbourRoom,
  type Direction, type PlayerAction, type TrapType,
} from "./protocol.ts";
import {
  CACHE_SLOT, EXIT_RADIUS, EXIT_X, EXIT_Y, approachPoint, blockedByFurniture, insideRoom,
  type EmbassyMap, type Furniture, type Room,
} from "./mansion.ts";
import {
  applyAction, applyInput, doorAnchor, hasFullSet, isActive,
  type MatchSim, type SimPlayer,
} from "./sim.ts";

/** Named for what they are to play against, not for any number they multiply. */
export type Difficulty = "rookie" | "agent" | "veteran";

export const DIFFICULTIES: readonly Difficulty[] = Object.freeze(["rookie", "agent", "veteran"]);

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = Object.freeze({
  rookie: "Rookie",
  agent: "Field agent",
  veteran: "Veteran",
});

export const DIFFICULTY_BLURBS: Readonly<Record<Difficulty, string>> = Object.freeze({
  rookie: "Slow to react and forgetful. Wanders, searches, rarely presses an attack.",
  agent: "Reacts at about a person's pace and remembers most of what it has searched.",
  veteran: "Reacts quickly, remembers everything it has seen, and traps what it leaves behind.",
});

type Tuning = Readonly<{
  /** Gap between decisions. Also how long it takes to notice someone walk in. */
  thinkMs: number;
  /** How long a searched piece stays remembered. Infinity means never forgotten. */
  recallMs: number;
  /** How readily it closes on a rival rather than carrying on with its errand. */
  aggression: number;
  /** Chance, per decision, that it considers spending a trap on the way out of a room. */
  trapChance: number;
  /** It breaks off and runs below this share of its health when a rival is in the room. */
  fleeBelow: number;
  /**
   * Whether it has learned that intelligence only ever hides in a room's marked cache.
   *
   * The embassy teaches this by stencilling the floor under the spot, and a rookie has not
   * picked it up yet, so it turns out whatever is nearest instead of going straight to the
   * cache. This is knowledge, not a handicap: nothing about how fast it moves or how hard it
   * hits changes, and a rookie that happens to start beside a cache opens it first.
   */
  cacheWise: boolean;
}>;

const TUNING: Readonly<Record<Difficulty, Tuning>> = Object.freeze({
  rookie: { thinkMs: 620, recallMs: 12_000, aggression: 0.35, trapChance: 0.1, fleeBelow: 0.5, cacheWise: false },
  agent: { thinkMs: 320, recallMs: 45_000, aggression: 0.7, trapChance: 0.3, fleeBelow: 0.35, cacheWise: true },
  veteran: { thinkMs: 170, recallMs: Infinity, aggression: 1, trapChance: 0.6, fleeBelow: 0.25, cacheWise: true },
});

export type Goal =
  | { kind: "escape" }
  | { kind: "hunt"; targetId: string }
  | { kind: "flee"; fromRoom: number }
  | { kind: "grab"; room: number; dropId: number }
  | { kind: "search"; room: number; furnitureId: number }
  | { kind: "trap"; room: number; targetId: number; trap: TrapType; door: Direction | null }
  | { kind: "roam"; room: number };

export type CpuMemory = {
  readonly playerId: string;
  readonly difficulty: Difficulty;
  /** Furniture this agent has turned out itself, and when. Rival searches are not visible. */
  searched: Map<number, number>;
  /** Rooms it has stood in, and when it last did. */
  visited: Map<number, number>;
  /** Where each rival was last actually seen, and when. */
  sightings: Map<string, { room: number; at: number }>;
  /** Traps it set itself. It knows to route round these; it knows nothing of anyone else's. */
  ownTraps: Set<number>;
  goal: Goal | null;
  /** When the current goal was chosen, so one that cannot be met is eventually dropped. */
  goalSince: number;
  /** Next moment it is allowed to reconsider. */
  thinkAt: number;
  /** Goals abandoned as unreachable, and when, so it does not pick them straight back up. */
  abandoned: Map<number, number>;
  /** Input sequence, because applyInput ignores anything not newer than the last. */
  seq: number;
  /** Its own generator, so a demo match replays identically from the same seed. */
  random: () => number;
};

/** mulberry32 again, kept local so a CPU's rolls never disturb the map generator's stream. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createCpu(playerId: string, difficulty: Difficulty, seed: number): CpuMemory {
  return {
    playerId, difficulty,
    searched: new Map(), visited: new Map(), sightings: new Map(), ownTraps: new Set(),
    goal: null, goalSince: 0, thinkAt: 0, abandoned: new Map(),
    seq: 0, random: createRandom(seed),
  };
}

// --- The room graph ------------------------------------------------------------------------

/**
 * First step of the shortest route from one room to another, or null if it is already there.
 *
 * Nine nodes, so a breadth-first sweep is both exact and free. Directions are walked in a
 * fixed order, which keeps a demo match reproducible.
 */
export function routeStep(map: EmbassyMap, from: number, to: number): Direction | null {
  if (from === to) return null;
  const firstStep = new Map<number, Direction>();
  const seen = new Set<number>([from]);
  const queue: number[] = [from];
  while (queue.length) {
    const at = queue.shift()!;
    for (const direction of DIRECTIONS) {
      if (!map.rooms[at].doors.includes(direction)) continue;
      const next = neighbourRoom(at, direction);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      firstStep.set(next, at === from ? direction : firstStep.get(at)!);
      if (next === to) return firstStep.get(next)!;
      queue.push(next);
    }
  }
  return null;
}

/** Rooms reachable from here, nearest first. Used to pick somewhere worth going. */
function roomsByDistance(map: EmbassyMap, from: number): { room: number; steps: number }[] {
  const out = [{ room: from, steps: 0 }];
  const seen = new Set<number>([from]);
  for (let i = 0; i < out.length; i++) {
    const { room, steps } = out[i];
    for (const direction of DIRECTIONS) {
      if (!map.rooms[room].doors.includes(direction)) continue;
      const next = neighbourRoom(room, direction);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      out.push({ room: next, steps: steps + 1 });
    }
  }
  return out;
}

// --- What this agent believes --------------------------------------------------------------

/** Where an agent has to stand to reach a piece: out from the wall for anything hanging. */
export function reachPoint(piece: Furniture): { x: number; y: number } {
  return piece.x === 0 || piece.y === 0 ? approachPoint(piece) : { x: piece.x, y: piece.y };
}

function forgetStale(memory: CpuMemory, now: number): void {
  const { recallMs } = TUNING[memory.difficulty];
  if (!Number.isFinite(recallMs)) return;
  for (const [id, at] of memory.searched) if (now - at > recallMs) memory.searched.delete(id);
  for (const [id, seen] of memory.sightings) if (now - seen.at > recallMs) memory.sightings.delete(id);
}

/**
 * Take in the room this agent is standing in.
 *
 * Only this room, and only what is visible in it: the same fog of war the snapshot builder
 * enforces for a human. A piece someone else has emptied is visibly turned out, so that is
 * fair game to notice; a rival two rooms away is not.
 */
function observe(sim: MatchSim, memory: CpuMemory, self: SimPlayer): void {
  memory.visited.set(self.room, sim.now);
  for (const piece of sim.map.rooms[self.room].furniture) {
    if (piece.emptied) memory.searched.set(piece.id, sim.now);
  }
  for (const other of sim.players.values()) {
    if (other.playerId === self.playerId || other.room !== self.room) continue;
    if (other.respawnAt > 0) continue;
    memory.sightings.set(other.playerId, { room: other.room, at: sim.now });
  }
}

// --- Choosing what to do -------------------------------------------------------------------

/** A rival in this room, in reach or close to it, ignoring anyone who cannot be hit. */
function rivalHere(sim: MatchSim, self: SimPlayer): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestGap = Infinity;
  for (const other of sim.players.values()) {
    if (other.playerId === self.playerId || other.room !== self.room) continue;
    if (other.respawnAt > 0 || sim.now < other.invulnerableUntil) continue;
    const gap = Math.hypot(other.x - self.x, other.y - self.y);
    if (gap < bestGap) { best = other; bestGap = gap; }
  }
  return best;
}

/** The piece this agent would most like to open in a given room, or null if it knows of none. */
function wantedPiece(
  sim: MatchSim, memory: CpuMemory, self: SimPlayer, room: number,
): Furniture | null {
  // A room it has never stood in is unknown: it may not pick a target inside one.
  if (!memory.visited.has(room)) return null;
  const cacheWise = TUNING[memory.difficulty].cacheWise;
  let best: Furniture | null = null;
  let bestScore = -Infinity;
  for (const piece of sim.map.rooms[room].furniture) {
    if (piece.emptied || memory.searched.has(piece.id) || memory.abandoned.has(piece.id)) continue;
    // Someone who knows the convention goes to the cache. Someone who does not opens
    // whatever is nearest, which is how a rookie ends up rummaging through the bookcases.
    const gap = room === self.room ? Math.hypot(piece.x - self.x, piece.y - self.y) : 0;
    const score = (cacheWise && piece.slot === CACHE_SLOT ? 600 : 0) - gap;
    if (score > bestScore) { best = piece; bestScore = score; }
  }
  return best;
}

function scoreGoals(sim: MatchSim, memory: CpuMemory, self: SimPlayer): Goal {
  const tuning = TUNING[memory.difficulty];
  const map = sim.map;
  const candidates: { goal: Goal; score: number }[] = [];

  // Carrying the full set beats everything: the match is one walk from over.
  if (hasFullSet(self)) candidates.push({ goal: { kind: "escape" }, score: 1000 });

  const rival = rivalHere(sim, self);
  if (rival) {
    const hurt = self.hp / Math.max(1, self.maxHp) < tuning.fleeBelow;
    if (hurt) {
      candidates.push({ goal: { kind: "flee", fromRoom: self.room }, score: 120 });
    } else {
      // Worth more when they are carrying something, because a takedown spills it, and worth
      // far more when they are already in arm's reach, because the swing costs no walking.
      const gap = Math.hypot(rival.x - self.x, rival.y - self.y);
      const base = gap <= ATTACK_RANGE ? 110 : 55;
      const carrying = rival.inventory.length;
      const edge = self.hp - rival.hp;
      candidates.push({
        goal: { kind: "hunt", targetId: rival.playerId },
        score: (base + carrying * 22 + Math.max(0, edge) * 6 - gap / 10) * tuning.aggression,
      });
    }
  }

  // Anything lying on the floor of this room is free, and dropped intelligence is the point.
  for (const drop of sim.drops) {
    if (drop.room !== self.room) continue;
    const gap = Math.hypot(drop.x - self.x, drop.y - self.y);
    const worth = MISSION_ITEMS.includes(drop.item as never) ? 150 : 70;
    candidates.push({ goal: { kind: "grab", room: drop.room, dropId: drop.id }, score: worth - gap / 12 });
  }

  // Somewhere to search. Rooms it has seen are scored on what it knows is still shut; rooms
  // it has never entered are worth going to look at precisely because it knows nothing.
  for (const { room, steps } of roomsByDistance(map, self.room)) {
    const travel = steps * 26;
    const piece = wantedPiece(sim, memory, self, room);
    if (piece) {
      const gap = room === self.room ? Math.hypot(piece.x - self.x, piece.y - self.y) / 12 : 0;
      const known = TUNING[memory.difficulty].cacheWise && piece.slot === CACHE_SLOT;
      const prize = known ? 95 : 42;
      candidates.push({ goal: { kind: "search", room, furnitureId: piece.id }, score: prize - travel - gap });
    } else if (!memory.visited.has(room) && !memory.abandoned.has(-1 - room)) {
      candidates.push({ goal: { kind: "roam", room }, score: 78 - travel });
    }
  }

  // A trap on the way out of a room it has finished with. Costs a decision, not a detour.
  const trap = pickTrap(sim, memory, self);
  if (trap && memory.random() < tuning.trapChance) candidates.push({ goal: trap, score: 60 });

  // Nothing known and nothing to do: go somewhere, anywhere, rather than stand still.
  if (!candidates.length) {
    const rooms = roomsByDistance(map, self.room).filter(entry => entry.room !== self.room);
    const pick = rooms[Math.floor(memory.random() * rooms.length)] ?? { room: self.room };
    return { kind: "roam", room: pick.room };
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].goal;
}

/** A doorway or an emptied piece worth rigging, if this agent is carrying anything to rig it with. */
function pickTrap(sim: MatchSim, memory: CpuMemory, self: SimPlayer): Goal | null {
  const trap = TRAP_TYPES.find(type => self.traps[type] > 0);
  if (!trap) return null;
  const room = sim.map.rooms[self.room];
  // A doorway catches whoever comes looking, and costs nothing to walk past on the way out.
  for (const direction of room.doors) {
    const id = canonicalDoorTrapId(self.room, direction);
    if (sim.traps.has(id) || memory.ownTraps.has(id) || memory.abandoned.has(id)) continue;
    return { kind: "trap", room: self.room, targetId: id, trap, door: direction };
  }
  // Failing that, the cache it has already turned out: the one place a rival is sure to go.
  for (const piece of room.furniture) {
    if (piece.slot !== CACHE_SLOT || !piece.emptied) continue;
    if (sim.traps.has(piece.id) || memory.ownTraps.has(piece.id) || memory.abandoned.has(piece.id)) continue;
    return { kind: "trap", room: self.room, targetId: piece.id, trap, door: null };
  }
  return null;
}

/** True once the goal has been met, or has become impossible to meet. */
function goalSpent(sim: MatchSim, memory: CpuMemory, self: SimPlayer, goal: Goal): boolean {
  switch (goal.kind) {
    case "escape": return !hasFullSet(self);
    case "hunt": {
      const target = sim.players.get(goal.targetId);
      return !target || target.room !== self.room || target.respawnAt > 0;
    }
    case "flee": return self.room !== goal.fromRoom;
    case "grab": return !sim.drops.some(drop => drop.id === goal.dropId);
    case "search": {
      const piece = sim.map.rooms[goal.room]?.furniture.find(entry => entry.id === goal.furnitureId);
      return !piece || piece.emptied || memory.searched.has(piece.id);
    }
    case "trap": return sim.traps.has(goal.targetId) || memory.ownTraps.has(goal.targetId);
    case "roam": return self.room === goal.room;
  }
}

// --- Getting there -------------------------------------------------------------------------

/** Where in the world this goal wants the agent to stand, and how close is close enough. */
function destinationOf(sim: MatchSim, self: SimPlayer, goal: Goal): { room: number; x: number; y: number; within: number } | null {
  switch (goal.kind) {
    case "escape":
      return { room: sim.map.exitRoom, x: EXIT_X, y: EXIT_Y, within: EXIT_RADIUS - 8 };
    case "hunt": {
      const target = sim.players.get(goal.targetId);
      if (!target) return null;
      return { room: target.room, x: target.x, y: target.y, within: ATTACK_RANGE - 8 };
    }
    case "flee": {
      // The doorway furthest from whoever is in here. Standing and trading is exactly what
      // it is trying not to do, so any exit will do, but the far one is the one to take.
      const room = sim.map.rooms[self.room];
      if (!room.doors.length) return null;
      const threat = rivalHere(sim, self);
      let best = room.doors[0];
      let bestGap = -Infinity;
      for (const door of room.doors) {
        const anchor = doorAnchor(door);
        const gap = threat ? Math.hypot(anchor.x - threat.x, anchor.y - threat.y) : 0;
        if (gap > bestGap) { best = door; bestGap = gap; }
      }
      const anchor = doorAnchor(best);
      return { room: self.room, x: anchor.x, y: anchor.y, within: PLAYER_RADIUS };
    }
    case "grab": {
      const drop = sim.drops.find(entry => entry.id === goal.dropId);
      if (!drop) return null;
      return { room: drop.room, x: drop.x, y: drop.y, within: INTERACT_RANGE - 14 };
    }
    case "search": {
      const piece = sim.map.rooms[goal.room]?.furniture.find(entry => entry.id === goal.furnitureId);
      if (!piece) return null;
      const spot = reachPoint(piece);
      return { room: goal.room, x: spot.x, y: spot.y, within: INTERACT_RANGE - 14 };
    }
    case "trap": {
      if (goal.door) {
        const anchor = doorAnchor(goal.door);
        // Stand short of the opening, or it walks through instead of rigging it.
        const inset = 30;
        return {
          room: goal.room,
          x: anchor.x === 0 ? inset : anchor.x === ROOM_W ? ROOM_W - inset : anchor.x,
          y: anchor.y === 0 ? inset : anchor.y === ROOM_H ? ROOM_H - inset : anchor.y,
          within: INTERACT_RANGE - 14,
        };
      }
      const piece = sim.map.rooms[goal.room]?.furniture.find(entry => entry.id === goal.targetId);
      if (!piece) return null;
      const spot = reachPoint(piece);
      return { room: goal.room, x: spot.x, y: spot.y, within: INTERACT_RANGE - 14 };
    }
    case "roam":
      return { room: goal.room, x: ROOM_W / 2, y: ROOM_H / 2, within: 60 };
  }
}

/**
 * Room-level navigation.
 *
 * Steering straight at a destination walks into the side of a desk and stays there, because
 * movePlayer's wall slide only helps when one axis is already clear. So each room is sampled
 * onto a coarse grid of standable cells and crossed breadth-first. The grid depends only on
 * the room's furniture, which never moves, so it is built once per room and reused.
 */
const NAV_CELL = 20;
const NAV_COLS = Math.ceil(ROOM_W / NAV_CELL);
const NAV_ROWS = Math.ceil(ROOM_H / NAV_CELL);
const navGrids = new WeakMap<Room, Uint8Array>();

function navGrid(room: Room): Uint8Array {
  const cached = navGrids.get(room);
  if (cached) return cached;
  const grid = new Uint8Array(NAV_COLS * NAV_ROWS);
  for (let cy = 0; cy < NAV_ROWS; cy++) {
    for (let cx = 0; cx < NAV_COLS; cx++) {
      const x = cx * NAV_CELL + NAV_CELL / 2;
      const y = cy * NAV_CELL + NAV_CELL / 2;
      grid[cy * NAV_COLS + cx] = insideRoom(x, y) && !blockedByFurniture(room, x, y) ? 1 : 0;
    }
  }
  navGrids.set(room, grid);
  return grid;
}

const navCell = (x: number, y: number) => {
  const cx = Math.max(0, Math.min(NAV_COLS - 1, Math.floor(x / NAV_CELL)));
  const cy = Math.max(0, Math.min(NAV_ROWS - 1, Math.floor(y / NAV_CELL)));
  return cy * NAV_COLS + cx;
};
const navPoint = (cell: number) => ({
  x: (cell % NAV_COLS) * NAV_CELL + NAV_CELL / 2,
  y: Math.floor(cell / NAV_COLS) * NAV_CELL + NAV_CELL / 2,
});

/**
 * The next place to walk towards inside this room, or null when nothing closer is reachable.
 *
 * Sweeps outward from where the agent stands and keeps whichever reachable cell lands nearest
 * the target, so an agent aiming at something it cannot stand on — a desk it wants to search,
 * a doorway on the far wall — still walks up to it rather than stopping short or giving up.
 */
export function nextWaypoint(
  room: Room, from: { x: number; y: number }, target: { x: number; y: number },
): { x: number; y: number } | null {
  const grid = navGrid(room);
  const start = navCell(from.x, from.y);
  if (!grid[start]) return null;
  const parent = new Int32Array(grid.length).fill(-2);
  parent[start] = -1;
  const queue = [start];
  let best = start;
  let bestGap = Math.hypot(navPoint(start).x - target.x, navPoint(start).y - target.y);
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const cx = cell % NAV_COLS, cy = Math.floor(cell / NAV_COLS);
    const gap = Math.hypot(navPoint(cell).x - target.x, navPoint(cell).y - target.y);
    if (gap < bestGap) { best = cell; bestGap = gap; }
    // Four-way only: two clear cell centres twenty apart always have a clear line between
    // them on an axis, which diagonals across a corner would not.
    const steps = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
    for (const [nx, ny] of steps) {
      if (nx < 0 || ny < 0 || nx >= NAV_COLS || ny >= NAV_ROWS) continue;
      const next = ny * NAV_COLS + nx;
      if (!grid[next] || parent[next] !== -2) continue;
      parent[next] = cell;
      queue.push(next);
    }
  }
  if (best === start) return null;
  let step = best;
  while (parent[step] !== start && parent[step] >= 0) step = parent[step];
  return navPoint(step);
}

/**
 * The unit vector that carries this agent one step closer to its destination.
 *
 * Another room means heading for the doorway that starts the route there; the same room means
 * following the grid. Once the grid has nothing nearer to offer, the agent aims straight at
 * the target, which is what carries it the last few pixels into reach or through an opening.
 */
function steer(
  sim: MatchSim, self: SimPlayer, destination: { room: number; x: number; y: number },
): { dx: number; dy: number } {
  let target = { x: destination.x, y: destination.y };
  if (destination.room !== self.room) {
    const direction = routeStep(sim.map, self.room, destination.room);
    if (!direction) return { dx: 0, dy: 0 };
    target = doorAnchor(direction);
  }
  const waypoint = nextWaypoint(sim.map.rooms[self.room], self, target);
  const aim = waypoint ?? target;
  return unit(aim.x - self.x, aim.y - self.y);
}

function unit(dx: number, dy: number): { dx: number; dy: number } {
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 0.0001) return { dx: 0, dy: 0 };
  return { dx: dx / magnitude, dy: dy / magnitude };
}

/**
 * How long an agent will chase one goal before writing it off.
 *
 * Navigation gets it to anything it can walk to, so a goal still unmet after this long is one
 * it cannot reach at all — a piece walled in by a rival's furniture-shaped luck, or a rival
 * who keeps stepping out of the room. Writing it off, and not picking it up again for a while,
 * is what stops an agent ping-ponging through a doorway for the rest of the match.
 */
const GOAL_PATIENCE_MS = 12_000;
const ABANDON_MS = 30_000;

// --- Acting ----------------------------------------------------------------------------------

/** The action this agent would take right now, standing where it is, or null. */
function actionFor(sim: MatchSim, memory: CpuMemory, self: SimPlayer, goal: Goal): PlayerAction | null {
  const near = (x: number, y: number, range: number) => Math.hypot(x - self.x, y - self.y) <= range;
  switch (goal.kind) {
    case "escape":
      return self.room === sim.map.exitRoom && near(EXIT_X, EXIT_Y, EXIT_RADIUS)
        ? { kind: "escape" } : null;
    case "hunt": {
      const target = sim.players.get(goal.targetId);
      if (!target || target.room !== self.room) return null;
      return near(target.x, target.y, ATTACK_RANGE) && sim.now >= self.attackReadyAt
        ? { kind: "attack" } : null;
    }
    case "grab": {
      const drop = sim.drops.find(entry => entry.id === goal.dropId);
      return drop && drop.room === self.room && near(drop.x, drop.y, INTERACT_RANGE)
        ? { kind: "pickup", dropId: drop.id } : null;
    }
    case "search": {
      const piece = sim.map.rooms[goal.room]?.furniture.find(entry => entry.id === goal.furnitureId);
      if (!piece || self.room !== goal.room || !near(piece.x, piece.y, INTERACT_RANGE)) return null;
      return { kind: "search", furnitureId: piece.id };
    }
    case "trap": {
      if (self.room !== goal.room) return null;
      if (goal.door) {
        const anchor = doorAnchor(goal.door);
        if (!near(anchor.x, anchor.y, INTERACT_RANGE)) return null;
      } else {
        const piece = sim.map.rooms[goal.room]?.furniture.find(entry => entry.id === goal.targetId);
        if (!piece || !near(piece.x, piece.y, INTERACT_RANGE)) return null;
      }
      return { kind: "plant", targetId: goal.targetId, trap: goal.trap };
    }
    case "flee":
    case "roam":
      return null;
  }
}

/**
 * Drive one CPU agent for one tick.
 *
 * Call it once per simulation step, before stepping the sim, exactly as the relay applies a
 * human's input and actions before stepping. Returns the goal it is pursuing, which is what
 * the tests read and what demo mode shows when asked.
 */
export function driveCpu(sim: MatchSim, memory: CpuMemory): Goal | null {
  const self = sim.players.get(memory.playerId);
  if (!self || sim.finished) return null;
  if (!isActive(self, sim.now)) {
    // Down, stunned or mid-search: hold still and let the rules run their course.
    applyCpuInput(sim, memory, 0, 0);
    if (self.respawnAt > 0) memory.goal = null;
    return memory.goal;
  }
  if (self.busy) { applyCpuInput(sim, memory, 0, 0); return memory.goal; }

  observe(sim, memory, self);
  forgetStale(memory, sim.now);

  for (const [id, at] of memory.abandoned) if (sim.now - at > ABANDON_MS) memory.abandoned.delete(id);

  // A goal held this long is one navigation could not deliver, so write it off and let the
  // scoring pick something else. Without this an agent can chase an unreachable piece for
  // the rest of the match, stepping in and out of the same doorway.
  if (memory.goal && sim.now - memory.goalSince > GOAL_PATIENCE_MS) {
    abandon(memory, memory.goal, sim.now);
    memory.goal = null;
  }

  // Reconsider on the tuning's clock, or the moment the current plan is spent. Waiting out
  // the clock is what makes a rookie feel slow on the uptake: it will keep walking towards
  // furniture for half a second after someone has walked in behind it.
  if (!memory.goal || goalSpent(sim, memory, self, memory.goal) || sim.now >= memory.thinkAt) {
    const chosen = scoreGoals(sim, memory, self);
    if (!memory.goal || !sameGoal(memory.goal, chosen)) memory.goalSince = sim.now;
    memory.goal = chosen;
    memory.thinkAt = sim.now + TUNING[memory.difficulty].thinkMs;
  }

  const goal = memory.goal;
  if (!goal) { applyCpuInput(sim, memory, 0, 0); return null; }

  const action = actionFor(sim, memory, self, goal);
  if (action) {
    applyCpuInput(sim, memory, 0, 0);
    applyCpuAction(sim, memory, self, goal, action);
    return goal;
  }

  const destination = destinationOf(sim, self, goal);
  if (!destination) { memory.goal = null; applyCpuInput(sim, memory, 0, 0); return null; }
  const move = steer(sim, self, destination);
  applyCpuInput(sim, memory, move.dx, move.dy);
  return goal;
}

/** Goals are compared by what they are about, so re-picking the same errand keeps its clock. */
function sameGoal(a: Goal, b: Goal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "search" && b.kind === "search") return a.furnitureId === b.furnitureId;
  if (a.kind === "trap" && b.kind === "trap") return a.targetId === b.targetId;
  if (a.kind === "grab" && b.kind === "grab") return a.dropId === b.dropId;
  if (a.kind === "hunt" && b.kind === "hunt") return a.targetId === b.targetId;
  if (a.kind === "roam" && b.kind === "roam") return a.room === b.room;
  return true;
}

/** Write a goal off for a while. Only the ones tied to a fixed thing are worth remembering. */
function abandon(memory: CpuMemory, goal: Goal, now: number): void {
  if (goal.kind === "search") memory.abandoned.set(goal.furnitureId, now);
  else if (goal.kind === "trap") memory.abandoned.set(goal.targetId, now);
  else if (goal.kind === "roam") memory.abandoned.set(-1 - goal.room, now);
}

function applyCpuInput(sim: MatchSim, memory: CpuMemory, dx: number, dy: number): void {
  memory.seq++;
  applyInput(sim, memory.playerId, memory.seq, dx, dy);
}

function applyCpuAction(
  sim: MatchSim, memory: CpuMemory, self: SimPlayer, goal: Goal, action: PlayerAction,
): void {
  applyAction(sim, memory.playerId, action);
  // Remember its own work: a search it started, and a trap it just spent.
  if (action.kind === "search") memory.searched.set(action.furnitureId, sim.now);
  if (action.kind === "plant") memory.ownTraps.add(action.targetId);
  if (goal.kind === "trap" || goal.kind === "search") memory.goal = null;
}
