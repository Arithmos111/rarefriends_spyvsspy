/**
 * Wire protocol and tuning constants shared by the browser game and the relay server.
 *
 * Both sides import this exact file: the browser through the FriendSDK esbuild bundle,
 * the server through Node's native TypeScript type stripping. Keeping one copy is what
 * lets the client predict movement with the same numbers the server uses to correct it.
 */

export const PROTOCOL_VERSION = 4;

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

export const FURNITURE_TYPES = ["safe", "desk", "cabinet", "crate", "locker", "console", "planter", "painting"] as const;
export type FurnitureType = typeof FURNITURE_TYPES[number];
export const FURNITURE_LABELS: Readonly<Record<FurnitureType, string>> = Object.freeze({
  safe: "Wall safe", desk: "Writing desk", cabinet: "Filing cabinet", crate: "Supply crate",
  locker: "Steel locker", console: "Comms console", planter: "Planter", painting: "Framed painting",
});

/** World-space collision footprint per furniture type, centred on its anchor. */
export const FURNITURE_FOOTPRINT: Readonly<Record<FurnitureType, Readonly<{ w: number; h: number }>>> = Object.freeze({
  safe: { w: 52, h: 40 }, desk: { w: 82, h: 50 }, cabinet: { w: 54, h: 44 }, crate: { w: 58, h: 58 },
  locker: { w: 50, h: 42 }, console: { w: 74, h: 46 }, planter: { w: 46, h: 46 }, painting: { w: 60, h: 26 },
});

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
  searched: boolean; emptied: boolean;
}>;

export type RoomDrop = Readonly<{ id: number; item: Carryable; x: number; y: number }>;

/** A trap the viewer is allowed to see, on furniture or on a doorway. */
export type RoomTrap = Readonly<{ targetId: number; type: TrapType; mine: boolean }>;

/** Centre-screen pickup flash, and other one-shot presentation cues. */
export type MatchCue =
  | { kind: "pickup"; item: Carryable }
  | { kind: "trap"; trap: TrapType }
  | { kind: "hurt"; amount: number }
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
      results: readonly PublicPlayer[] }
  | { t: "leaderboard"; rows: readonly LeaderboardRow[] }
  | { t: "friend.name"; friendName: string | null }
  | { t: "error"; message: string }
  | { t: "pong"; at: number };

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
