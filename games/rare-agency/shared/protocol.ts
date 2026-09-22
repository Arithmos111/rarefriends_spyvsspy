/**
 * Wire protocol and tuning constants shared by the browser game and the relay server.
 *
 * Both sides import this exact file: the browser through the FriendSDK esbuild bundle,
 * the server through Node's native TypeScript type stripping. Keeping one copy is what
 * lets the client predict movement with the same numbers the server uses to correct it.
 */

export const PROTOCOL_VERSION = 12;

/** Server simulation rate. Snapshots are sent at this rate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
/** Client input send rate. */
export const INPUT_HZ = 30;
export const INPUT_MS = 1000 / INPUT_HZ;

/** Room interior, in world units. The floor is drawn as a shallow isometric diamond. */
export const ROOM_W = 520;
export const ROOM_H = 360;

/** The embassy is a GRID_W x GRID_H block of connected rooms. */
export const GRID_W = 3;
export const GRID_H = 3;
export const ROOM_COUNT = GRID_W * GRID_H;

export const PLAYER_RADIUS = 15;
export const PLAYER_SPEED = 200;
/** A suspended tab must not teleport a player through a wall. */
export const MAX_STEP_MS = 50;

export const DOOR_HALF_WIDTH = 46;
/** How far past a doorway you must walk to change rooms. */
export const DOOR_DEPTH = 10;

export const SEARCH_MS = 900;
export const SEARCH_MS_LOCKPICK = 550;
export const PLANT_MS = 700;
export const DISARM_MS = 850;
/**
 * Reach must exceed every furniture footprint's half-width plus the player radius, or an
 * agent cannot stand anywhere that is both outside the object and close enough to use it.
 * The widest piece (desk, 82 across) needs 56; this leaves margin on top. Covered by
 * "every furniture type can be reached from every side" in tests/sim.test.mjs.
 */
export const INTERACT_RANGE = 74;

export const ATTACK_RANGE = 46;
/** Five hit points means a brawl needs five landed blows, so the swing rate is quicker. */
export const ATTACK_COOLDOWN_MS = 750;
export const ATTACK_WINDUP_MS = 180;
export const HIT_STUN_MS = 380;
export const PLAYER_MAX_HP = 5;
/** A vest raises an agent's ceiling above the starting maximum. */
export const PLAYER_HP_CEILING = 8;
export const FIST_DAMAGE = 1;
export const KNIFE_DAMAGE = 2;
export const RESPAWN_MS = 4000;
export const BUCKET_STUN_MS = 3000;
export const SPAWN_INVULNERABLE_MS = 1500;

export const MATCH_SECONDS = 300;
export const LOBBY_MAX_PLAYERS = 4;
export const LOBBY_MIN_PLAYERS = 2;
export const LOBBY_AUTOSTART_MS = 5000;
/**
 * How long one member may hold up a lobby where everyone else is ready before being removed.
 *
 * Counted only while every other member is ready, so nobody is dropped for taking their time
 * in a lobby that was not waiting on them.
 */
export const LOBBY_READY_TIMEOUT_MS = 30_000;

/**
 * Decide who, if anyone, is holding a lobby up.
 *
 * A lobby counts as held up only when it has enough members to start and at least one is
 * ready while at least one is not: nobody should be dropped from a lobby that was never
 * waiting on them, and a lobby where nobody is ready is not waiting on anyone in particular.
 *
 * Returns the timestamp each member's clock should hold, so callers can persist it and ask
 * again later. Pure, so the rule can be tested without standing up a relay.
 */
export function stragglerClock<T extends { ready: boolean; holdingUpSince: number | null }>(
  members: readonly T[], at: number,
): (number | null)[] {
  const unready = members.filter(member => !member.ready);
  const heldUp = members.length >= LOBBY_MIN_PLAYERS
    && unready.length > 0 && unready.length < members.length;
  return members.map(member => {
    if (!heldUp || member.ready) return null;
    return member.holdingUpSince ?? at;
  });
}

/** True once a member has held a ready lobby up for longer than the grace period. */
export function stragglerExpired(holdingUpSince: number | null, at: number): boolean {
  return holdingUpSince !== null && at - holdingUpSince >= LOBBY_READY_TIMEOUT_MS;
}
/** A lobby with nobody in it is reclaimed after this long. */
export const LOBBY_IDLE_MS = 60_000;

export const MISSION_ITEMS = ["documents", "passport", "cash", "disguise"] as const;
export type MissionItem = typeof MISSION_ITEMS[number];
export const MISSION_ITEM_LABELS: Readonly<Record<MissionItem, string>> = Object.freeze({
  documents: "Secret documents",
  passport: "Forged passport",
  cash: "Bearer bonds",
  disguise: "Disguise kit",
});

export const POWER_UPS = ["medkit", "vest", "knife"] as const;
export type PowerUp = typeof POWER_UPS[number];
export const POWER_UP_LABELS: Readonly<Record<PowerUp, string>> = Object.freeze({
  medkit: "Field medkit",
  vest: "Ballistic vest",
  knife: "Stiletto knife",
});
export const POWER_UP_BLURBS: Readonly<Record<PowerUp, string>> = Object.freeze({
  medkit: "Restores 3 health, up to your maximum.",
  vest: "Raises your maximum health by 1 and heals you for it.",
  knife: "Your strikes hit for 2 instead of 1. Only one exists per match.",
});
/** A medkit restores this much; a vest adds this much ceiling. */
export const MEDKIT_HEAL = 3;
export const VEST_BONUS_HP = 1;

/** Anything an agent can be carrying or find. Mission items are what the gate needs. */
export type Carryable = MissionItem | PowerUp;
export function isPowerUp(value: Carryable): value is PowerUp {
  return (POWER_UPS as readonly string[]).includes(value);
}
export function carryableLabel(value: Carryable): string {
  return isPowerUp(value) ? POWER_UP_LABELS[value] : MISSION_ITEM_LABELS[value];
}

export const TRAP_TYPES = ["bomb", "spring", "bucket"] as const;
export type TrapType = typeof TRAP_TYPES[number];
export const TRAP_LABELS: Readonly<Record<TrapType, string>> = Object.freeze({
  bomb: "Letter bomb",
  spring: "Spring trap",
  bucket: "Water bucket",
});
export const TRAP_IS_LETHAL: Readonly<Record<TrapType, boolean>> = Object.freeze({
  bomb: true, spring: true, bucket: false,
});

export const FURNITURE_TYPES = [
  "safe", "desk", "cabinet", "crate", "locker", "console", "planter", "painting",
  "table", "bookcase", "barrel", "bench",
  /** Hung on a wall rather than standing on the floor. See WALL_MOUNTED. */
  "wallclock", "wallart",
] as const;
export type FurnitureType = typeof FURNITURE_TYPES[number];
export const FURNITURE_LABELS: Readonly<Record<FurnitureType, string>> = Object.freeze({
  safe: "Wall safe", desk: "Writing desk", cabinet: "Filing cabinet", crate: "Supply crate",
  locker: "Steel locker", console: "Comms console", planter: "Planter", painting: "Framed painting",
  table: "Meeting table", bookcase: "Bookcase", barrel: "Wine barrel", bench: "Bench",
  wallclock: "Wall clock", wallart: "Framed portrait",
});

/**
 * Furniture that hangs on a wall instead of standing on the floor.
 *
 * These are searched and trapped like anything else — a safe behind a portrait is the oldest
 * trick there is — but they do not block movement, and they are drawn flat against the wall
 * rather than sorted among the floor pieces.
 */
export const WALL_MOUNTED: ReadonlySet<FurnitureType> = new Set<FurnitureType>(["wallclock", "wallart"]);
export const isWallMounted = (type: FurnitureType): boolean => WALL_MOUNTED.has(type);

/**
 * World-space collision footprint per furniture type, centred on its anchor.
 *
 * Nothing here may be wider or deeper than INTERACT_RANGE * 2 - PLAYER_RADIUS * 2, or an
 * agent could stand against its long side and still be out of reach; tests/sim.test.mjs
 * checks that for every type.
 */
export const FURNITURE_FOOTPRINT: Readonly<Record<FurnitureType, Readonly<{ w: number; h: number }>>> = Object.freeze({
  safe: { w: 52, h: 40 }, desk: { w: 82, h: 50 }, cabinet: { w: 54, h: 44 }, crate: { w: 58, h: 58 },
  locker: { w: 50, h: 42 }, console: { w: 74, h: 46 }, planter: { w: 46, h: 46 }, painting: { w: 60, h: 26 },
  table: { w: 86, h: 58 }, bookcase: { w: 66, h: 38 }, barrel: { w: 48, h: 48 }, bench: { w: 76, h: 34 },
  // Wall pieces never collide, so these bound reach and the gap between hangings only.
  wallclock: { w: 44, h: 16 }, wallart: { w: 52, h: 16 },
});

/**
 * What each room is furnished with, by room index, matching ROOM_NAMES below. A records
 * vault full of planters reads as noise, so every room draws only from furniture that
 * belongs in it. Both sides derive furniture from the seed, so this must stay deterministic.
 */
export const ROOM_FURNITURE: readonly (readonly FurnitureType[])[] = Object.freeze([
  ["desk", "cabinet", "bench", "planter", "table"],        // Reception
  ["console", "cabinet", "safe", "locker", "desk"],         // Cipher Room
  ["desk", "bookcase", "safe", "painting", "cabinet"],      // Ambassador's Study
  ["cabinet", "locker", "safe", "crate", "bookcase"],       // Records Vault
  ["planter", "crate", "bench", "barrel", "table"],         // Courtyard Gate
  ["console", "locker", "cabinet", "crate", "desk"],        // Signals Room
  ["crate", "locker", "bench", "cabinet", "barrel"],        // Servants' Stair
  ["barrel", "crate", "bookcase", "locker", "bench"],       // Wine Cellar
  ["table", "painting", "planter", "bookcase", "bench"],    // Great Hall
]);

/**
 * Small objects that sit on top of flat furniture.
 *
 * Purely cosmetic and derived from the piece id, so they cost nothing on the wire and both
 * sides agree without being told. They are what makes a cipher room look like a cipher room
 * rather than a records vault with different labels.
 */
export const PROP_KINDS = [
  "telephone", "papers", "books", "lamp", "bottles", "radio", "candelabra", "toolbox", "ledger",
] as const;
export type PropKind = typeof PROP_KINDS[number];

/** What each room leaves lying about. */
export const ROOM_PROPS: readonly (readonly PropKind[])[] = Object.freeze([
  ["telephone", "ledger", "lamp"],        // Reception
  ["radio", "papers", "lamp"],            // Cipher Room
  ["books", "lamp", "papers"],            // Ambassador's Study
  ["ledger", "papers", "books"],          // Records Vault
  ["toolbox", "lamp", "bottles"],         // Courtyard Gate
  ["radio", "toolbox", "papers"],         // Signals Room
  ["toolbox", "bottles", "candelabra"],   // Servants' Stair
  ["bottles", "candelabra", "toolbox"],   // Wine Cellar
  ["candelabra", "books", "bottles"],     // Great Hall
]);

/** Furniture with a flat top wide enough to stand something on. */
export const PROP_SURFACES: ReadonlySet<FurnitureType> = new Set<FurnitureType>([
  "desk", "table", "cabinet", "crate", "safe", "console", "barrel", "bookcase",
]);

/** What hangs on each room's walls. Drawn from separately, at wall anchors. */
export const ROOM_WALL_FURNITURE: readonly (readonly FurnitureType[])[] = Object.freeze([
  ["wallclock", "wallart"],  // Reception
  ["wallclock"],             // Cipher Room
  ["wallart", "wallart"],    // Ambassador's Study
  ["wallclock"],             // Records Vault
  ["wallclock"],             // Courtyard Gate
  ["wallclock", "wallart"],  // Signals Room
  ["wallart"],               // Servants' Stair
  ["wallart"],               // Wine Cellar
  ["wallart", "wallart"],    // Great Hall
]);

/** Purely decorative room dressing. Drawn from the map seed, never collidable. */
export const DECOR_TYPES = ["rug", "portrait", "banner", "lamp", "clock", "bookshelf", "flag"] as const;
export type DecorType = typeof DECOR_TYPES[number];
export type RoomDecor = Readonly<{ type: DecorType; x: number; y: number; variant: number }>;

/**
 * Trap targets share one id space so a single number identifies either. Furniture uses
 * roomIndex * 100 + slot (slots 0-11); doorways use roomIndex * 100 + 80 + direction index.
 */
export const DOOR_TRAP_BASE = 80;
export function doorTrapId(roomIndex: number, direction: Direction): number {
  return roomIndex * 100 + DOOR_TRAP_BASE + DIRECTIONS.indexOf(direction);
}
export function isDoorTrapId(id: number): boolean {
  return id % 100 >= DOOR_TRAP_BASE;
}
export function doorTrapDirection(id: number): Direction {
  return DIRECTIONS[(id % 100) - DOOR_TRAP_BASE];
}

/**
 * The id of the doorway between two rooms, as seen from either side.
 *
 * A doorway is one physical opening with two descriptions: room A's north door is room B's
 * south door. Keying a trap by whichever side planted it meant walking through from the far
 * side looked up a different id and missed the trap entirely. Both sides now resolve to the
 * same id, chosen as the lower-numbered room's description of the opening, so a trapped
 * doorway is trapped for everyone going either way.
 */
export function canonicalDoorTrapId(roomIndex: number, direction: Direction): number {
  const neighbour = neighbourRoom(roomIndex, direction);
  if (neighbour === null || neighbour > roomIndex) return doorTrapId(roomIndex, direction);
  return doorTrapId(neighbour, oppositeDirection(direction));
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === "north" ? "south" : direction === "south" ? "north"
    : direction === "west" ? "east" : "west";
}

export type PlayerAction =
  | { kind: "search"; furnitureId: number }
  /** targetId is a furniture id or a doorway id; see doorTrapId. */
  | { kind: "plant"; targetId: number; trap: TrapType }
  | { kind: "disarm"; targetId: number }
  | { kind: "pickup"; dropId: number }
  | { kind: "attack" }
  | { kind: "escape" }
  | { kind: "cancel" };

export type ClientMessage =
  | { t: "hello"; protocol: number; friendId: string; codename: string }
  | { t: "lobby.list" }
  | { t: "lobby.create"; name: string; isPrivate: boolean; kitId: string }
  | { t: "lobby.join"; code: string; kitId: string }
  | { t: "lobby.quick"; kitId: string }
  | { t: "lobby.leave" }
  | { t: "lobby.ready"; ready: boolean }
  | { t: "lobby.kit"; kitId: string }
  | { t: "friend.name"; name: string }
  | { t: "leaderboard" }
  | { t: "lobby.start" }
  | { t: "input"; seq: number; dx: number; dy: number }
  | { t: "action"; seq: number; action: PlayerAction }
  | { t: "ping"; at: number };

export type LobbySummary = Readonly<{
  code: string; name: string; players: number; capacity: number;
  state: "waiting" | "starting" | "playing"; isPrivate: boolean; host: string;
}>;

export type LobbyMember = Readonly<{
  playerId: string; codename: string; friendId: string; ready: boolean;
  isHost: boolean; kitId: string; genesis: boolean; friendName: string | null;
}>;

export type PublicPlayer = Readonly<{
  playerId: string; codename: string; friendId: string; genesis: boolean;
  friendName: string | null;
  items: number; deaths: number; takedowns: number; connected: boolean;
  hasKnife: boolean; score: number;
}>;

/**
 * One agent's line in the end-of-match recap.
 *
 * Sent once, with `match.end`, rather than folded into the per-tick scoreboard: damage
 * tallies would tell you how a rival's match is going from across the embassy, and fog of
 * war is the game. `points` is the career award for this match, not the match score.
 */
export type RecapRow = Readonly<{
  playerId: string; codename: string; friendId: string; genesis: boolean;
  friendName: string | null;
  place: number; won: boolean; score: number;
  items: number; takedowns: number; deaths: number;
  hits: number; damageDealt: number; damageTaken: number; powerUps: number;
  points: number;
}>;

/** Career totals, kept per Friend across every match the relay has hosted. */
export type LeaderboardRow = Readonly<{
  friendId: string; friendName: string | null; codename: string;
  matches: number; wins: number; escapes: number;
  items: number; takedowns: number; deaths: number; points: number;
}>;

export const MAX_FRIEND_NAME = 18;
/** Letters, digits, spaces, apostrophes and hyphens. Rendered in parentheses after the Friend. */
export const FRIEND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '\-]{0,17}$/;
export function normaliseFriendName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, MAX_FRIEND_NAME);
  return trimmed && FRIEND_NAME_PATTERN.test(trimmed) ? trimmed : null;
}
/** How a Friend is shown wherever there is room for it. */
export function displayName(codename: string, friendName: string | null): string {
  return friendName ? `${codename} (${friendName})` : codename;
}

/** Points awarded once per match, totalled into the career leaderboard. */
/**
 * Career points, which are deliberately not the match score.
 *
 * The match score rewards playing well within one match. Career standings reward turning up
 * and winning, so a long game and a short one are worth the same and nobody can farm the
 * board by grinding items in a match they were never going to win.
 */
export const CAREER_POINTS_PLAYED = 1;
export const CAREER_POINTS_WIN = 2;
export const careerPointsFor = (won: boolean): number =>
  CAREER_POINTS_PLAYED + (won ? CAREER_POINTS_WIN : 0);

export const SCORE_ESCAPE = 100;
export const SCORE_PER_ITEM = 10;
export const SCORE_PER_TAKEDOWN = 5;
export const SCORE_TIME_WIN = 40;
export const SCORE_SURVIVED = 5;

/** A player as seen inside the viewer's own room. */
export type RoomActor = Readonly<{
  playerId: string; friendId: string; codename: string; genesis: boolean;
  friendName: string | null;
  x: number; y: number; facing: "up" | "down" | "left" | "right"; walking: boolean;
  hp: number; maxHp: number; hasKnife: boolean;
  stunnedMs: number; attackingMs: number; invulnerableMs: number; busy: BusyState | null;
}>;

export type BusyState = Readonly<{ kind: "search" | "plant" | "disarm"; targetId: number; progress: number }>;

export type RoomFurniture = Readonly<{
  id: number; type: FurnitureType; x: number; y: number;
  /** Which anchor it stands on. The client uses it to find the cache and mark the floor. */
  slot: number;
  searched: boolean; emptied: boolean;
}>;

export type RoomDrop = Readonly<{ id: number; item: Carryable; x: number; y: number }>;

/** A trap the viewer is allowed to see, on furniture or on a doorway. */
export type RoomTrap = Readonly<{
  targetId: number; type: TrapType; mine: boolean;
  /** For a doorway trap, which of the viewer's own walls it sits in. Null for furniture. */
  direction: Direction | null;
}>;

/**
 * A short-lived world effect drawn at a point in the viewer's room: a trap going off, or a
 * blow landing. Everyone standing in the room sees it, so a detonation reads as an event in
 * the world rather than as private feedback to whoever it happened to.
 */
export const EFFECT_KINDS = ["bomb", "spring", "bucket", "slash", "impact", "damage1", "damage2"] as const;
export type EffectKind = typeof EFFECT_KINDS[number];
export const EFFECT_DURATION_MS: Readonly<Record<EffectKind, number>> = Object.freeze({
  bomb: 900, spring: 720, bucket: 860, slash: 260, impact: 340,
  // Floating damage numbers, which rise and fade above whoever was hit.
  damage1: 850, damage2: 850,
});
export type RoomEffect = Readonly<{ id: number; kind: EffectKind; x: number; y: number; ageMs: number }>;

/** Centre-screen pickup flash, and other one-shot presentation cues. */
export type MatchCue =
  | { kind: "pickup"; item: Carryable }
  | { kind: "trap"; trap: TrapType }
  /** Your trap caught somebody else. */
  | { kind: "trap-sprung"; trap: TrapType }
  | { kind: "hurt"; amount: number }
  /** You connected. Carries the damage so the attacker hears a heavier hit for the knife. */
  | { kind: "hit"; amount: number }
  | { kind: "heal"; amount: number }
  | { kind: "takedown" }
  | { kind: "downed" };

export type MatchSnapshot = Readonly<{
  t: "snapshot"; tick: number; ackSeq: number; secondsLeft: number;
  roomIndex: number; roomName: string;
  doors: readonly ("north" | "south" | "east" | "west")[];
  exitHere: boolean;
  self: RoomActor & Readonly<{
    inventory: readonly MissionItem[];
    powerUps: readonly PowerUp[];
    traps: Readonly<Record<TrapType, number>>;
    hasDetector: boolean; hasLockpick: boolean; hasDisarm: boolean; respawnMs: number;
  }>;
  actors: readonly RoomActor[];
  furniture: readonly RoomFurniture[];
  /** Only traps the viewer planted, or can see with a detector. Covers furniture and doorways. */
  traps: readonly RoomTrap[];
  drops: readonly RoomDrop[];
  /** Trap detonations and blows landing in this room, for the duration of their animation. */
  effects: readonly RoomEffect[];
  scoreboard: readonly PublicPlayer[];
}>;

export type MatchEvent = Readonly<{ at: number; text: string; tone: "info" | "good" | "bad" | "alert" }>;

export type ServerMessage =
  | { t: "hello.ok"; playerId: string; codename: string; genesis: boolean; protocol: number; friendName: string | null }
  | { t: "lobby.list"; lobbies: readonly LobbySummary[]; onlinePlayers: number; activeMatches: number }
  | { t: "lobby.state"; code: string; name: string; isPrivate: boolean; members: readonly LobbyMember[];
      state: "waiting" | "starting" | "playing"; startsInMs: number | null }
  | { t: "lobby.left" }
  | { t: "match.start"; roomNames: readonly string[]; gridW: number; gridH: number; exitRoom: number; seed: number }
  | MatchSnapshot
  | { t: "events"; events: readonly MatchEvent[] }
  | { t: "cues"; cues: readonly MatchCue[] }
  | { t: "match.end"; winner: string | null; winnerName: string | null; reason: string;
      /** Set when the winner reached the gate, which plays the escape sequence. */
      escaped: boolean;
      results: readonly PublicPlayer[];
      /** Per-agent tallies for the recap shown after the escape sequence. */
      recap: readonly RecapRow[];
      /** This viewer's own career standing, after the match was folded in. */
      career: Readonly<{ won: boolean; earned: number; points: number; place: number; of: number }> | null }
  | { t: "leaderboard"; rows: readonly LeaderboardRow[] }
  | { t: "friend.name"; friendName: string | null }
  | { t: "error"; message: string }
  | { t: "pong"; at: number };

/**
 * Where a room's name plate hangs: which of the two visible walls, and where along it.
 *
 * Only the north and west walls face the camera. A plate over a doorway reads as a signpost
 * pointing through it rather than as the name of the room you are standing in, so a wall with
 * no doorway is preferred. The centre room has doorways on all four sides and three others
 * have them on both visible walls, so in those cases the plate goes on the longer wall and
 * sits beside the opening instead of over it, narrowed to fit the clear run.
 *
 * Shared by the renderer, which draws it, and by map generation, which keeps wall dressing
 * and hangings clear of it. They must agree, or the plate collides with a portrait again.
 */
export function roomSignPlacement(doors: readonly Direction[]): {
  onNorth: boolean; centre: number; width: number;
} {
  const northClear = !doors.includes("north");
  const westClear = !doors.includes("west");
  if (northClear || westClear) {
    const onNorth = northClear;
    const span = onNorth ? ROOM_W : ROOM_H;
    return { onNorth, centre: span / 2, width: span * 0.52 };
  }
  // Both are pierced. The north wall is the longer of the two, so it leaves the wider run.
  // The plate is centred in that run with equal margins, so it reads as hung beside the
  // opening rather than crowded up against either it or the corner.
  const span = ROOM_W;
  const run = span / 2 - DOOR_HALF_WIDTH;
  const margin = 24;
  const width = Math.min(span * 0.52, run - margin * 2);
  return { onNorth: true, centre: run / 2, width };
}

export const ROOM_NAMES: readonly string[] = Object.freeze([
  "Reception", "Cipher Room", "Ambassador's Study",
  "Records Vault", "Courtyard Gate", "Signals Room",
  "Servants' Stair", "Wine Cellar", "Great Hall",
]);

export const DIRECTIONS = ["north", "south", "east", "west"] as const;
export type Direction = typeof DIRECTIONS[number];

export function neighbourRoom(index: number, direction: Direction): number | null {
  const rx = index % GRID_W, ry = Math.floor(index / GRID_W);
  const nx = rx + (direction === "east" ? 1 : direction === "west" ? -1 : 0);
  const ny = ry + (direction === "south" ? 1 : direction === "north" ? -1 : 0);
  if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return null;
  return ny * GRID_W + nx;
}

export function roomDoors(index: number): readonly Direction[] {
  return DIRECTIONS.filter(direction => neighbourRoom(index, direction) !== null);
}
