/**
 * The training run.
 *
 * A single-player rehearsal that steps the real simulation in the browser, with no relay and
 * no lobby, so it starts instantly and cannot be affected by other players. Every lesson is
 * completed by actually performing the action on the real rules: nothing here is mimed, and
 * the view the trainee sees is built by the same code that builds a live match's snapshots.
 *
 * The mansion is staged rather than randomised, so each lesson has what it needs within reach
 * and the sequence is the same for everybody being walked through it.
 */
import {
  MISSION_ITEMS, PLAYER_MAX_HP, ROOM_H, ROOM_W, doorTrapId,
  type Direction, type MatchSnapshot, type PlayerAction, type TrapType,
} from "./shared/protocol.ts";
import {
  applyAction, applyInput, createMatch, doorAnchor, stepMatch, type MatchSim,
} from "./shared/sim.ts";
import { buildSnapshot } from "./shared/view.ts";

export const TRAINEE = "trainee";
export const DUMMY = "dummy";

/** A fixed seed, so the training mansion is the same run to run and lesson to lesson. */
const TUTORIAL_SEED = 20260920;

/**
 * A lesson cannot be cleared until it has been on screen this long. Without it a lesson the
 * trainee happens to satisfy on the way into it — walking through a doorway on the momentum
 * of the movement lesson, say — ticks off before they have read a word of it.
 */
export const LESSON_DWELL_MS = 900;

export type Lesson = Readonly<{
  id: string;
  title: string;
  /** What to do, in the imperative. Shown as the current objective. */
  body: string;
  /** Staging applied once, when the lesson begins. */
  enter?: (state: TutorialState) => void;
  /** Run every tick while this lesson is current, to keep its objective reachable. */
  tick?: (state: TutorialState) => void;
  /** True once the trainee has done the thing. */
  done: (state: TutorialState) => boolean;
}>;

export type TutorialState = {
  sim: MatchSim;
  index: number;
  /** Set when the final lesson is cleared. */
  finished: boolean;
  /** Distance walked since the movement lesson began. */
  travelled: number;
  /** Room the trainee was in when the current lesson started. */
  roomAtEntry: number;
  /** Furniture searched so far, for the searching lesson. */
  searches: number;
  /** How long the current lesson has been on screen. */
  shownMs: number;
  entered: boolean;
};

const trainee = (state: TutorialState) => state.sim.players.get(TRAINEE)!;
const dummy = (state: TutorialState) => state.sim.players.get(DUMMY)!;

/**
 * The piece of furniture a lesson should stage onto: the nearest one that has not been
 * searched yet, falling back to the nearest of any. Preferring an unsearched piece matters,
 * because a lesson that asks for a search cannot be cleared on furniture already turned out.
 */
export function nearestFurniture(state: TutorialState) {
  const self = trainee(state);
  const room = state.sim.map.rooms[self.room];
  const pick = (pieces: typeof room.furniture) => {
    let best = null as typeof room.furniture[number] | null;
    let bestGap = Infinity;
    for (const piece of pieces) {
      const gap = Math.hypot(piece.x - self.x, piece.y - self.y);
      if (gap < bestGap) { best = piece; bestGap = gap; }
    }
    return best;
  };
  return pick(room.furniture.filter(piece => !piece.searched)) ?? pick(room.furniture);
}

/**
 * Make sure the documents are somewhere the trainee can actually reach: the nearest unsearched
 * piece in whatever room they are currently standing in. Re-checked as they move, so walking
 * out of the room mid-lesson moves the objective with them rather than stranding it.
 */
function seedDocuments(state: TutorialState): void {
  const self = trainee(state);
  const already = state.sim.map.rooms[self.room].furniture
    .some(piece => piece.contents === "documents" && !piece.emptied);
  if (already) return;
  const piece = nearestFurniture(state);
  if (!piece || piece.contents) return;
  piece.contents = "documents";
  piece.searched = false;
  piece.emptied = false;
}

export const LESSONS: readonly Lesson[] = Object.freeze([
  {
    id: "move",
    title: "Move",
    body: "WASD, the arrow keys or the stick moves your agent. You can also tap where you want to go. Walk a little way to carry on.",
    done: state => state.travelled > 210,
  },
  {
    id: "rooms",
    title: "Rooms",
    body: "The mansion is nine rooms and you only ever see the one you are standing in. Walk through a doorway.",
    done: state => trainee(state).room !== state.roomAtEntry,
  },
  {
    id: "search",
    title: "Search",
    body: "Everything worth having is hidden inside the furniture. Walk up to any piece, then press E, space or the action button to search it.",
    done: state => state.searches > 0,
  },
  {
    id: "collect",
    title: "Take the intelligence",
    body: "Four items win the match: the documents, the passport, the bonds and the disguise. The documents are in this room. Keep searching until you find them.",
    enter: state => {
      const self = trainee(state);
      // Start this lesson empty-handed, or a mission item turned up by the searching lesson
      // would clear it before the trainee has picked anything up on purpose.
      self.inventory = [];
      self.itemsFound = 0;
      seedDocuments(state);
    },
    tick: seedDocuments,
    done: state => trainee(state).inventory.length > 0,
  },
  {
    id: "trap",
    title: "Set a trap",
    body: "Press Q, or the trap button, and pick one. A trap on a searched cabinet catches whoever comes looking. Walk up to a piece and set one.",
    enter: state => {
      const self = trainee(state);
      for (const type of ["bomb", "spring", "bucket"] as TrapType[]) self.traps[type] = 2;
    },
    done: state => state.sim.traps.size > 0,
  },
  {
    id: "doortrap",
    title: "Trap a doorway",
    body: "Doorways take traps too. Stand in a doorway and set one there — it fires on whoever walks through, including you.",
    done: state => {
      const self = trainee(state);
      const room = state.sim.map.rooms[self.room];
      return room.doors.some((direction: Direction) =>
        state.sim.traps.has(doorTrapId(self.room, direction)));
    },
  },
  {
    id: "strike",
    title: "Strike",
    body: "Space, or the strike button, swings at anyone in arm's reach. A training dummy has been brought in. Hit it.",
    enter: state => {
      const self = trainee(state);
      const target = dummy(state);
      target.room = self.room;
      target.x = Math.min(ROOM_W - 40, Math.max(40, self.x + 46));
      target.y = self.y;
      target.hp = PLAYER_MAX_HP;
      target.maxHp = PLAYER_MAX_HP;
      target.invulnerableUntil = 0;
      target.respawnAt = 0;
      self.attackReadyAt = 0;
    },
    done: state => dummy(state).hp < dummy(state).maxHp,
  },
  {
    id: "knife",
    title: "The stiletto",
    body: "There is exactly one stiletto in the mansion and you are holding it. It hits for two instead of one, and it drops where you fall. Strike again.",
    enter: state => {
      const self = trainee(state);
      const target = dummy(state);
      self.knife = true;
      if (!self.powerUps.includes("knife")) self.powerUps.push("knife");
      self.attackReadyAt = 0;
      target.hp = target.maxHp;
      target.stunnedUntil = 0;
      target.invulnerableUntil = 0;
      target.room = self.room;
      target.x = Math.min(ROOM_W - 40, Math.max(40, self.x + 46));
      target.y = self.y;
    },
    done: state => dummy(state).hp <= dummy(state).maxHp - 2,
  },
  {
    id: "escape",
    title: "Get out",
    body: "With all four items, reach the courtyard gate and go. You have the set — the gate is in this room. Stand on it and press E.",
    enter: state => {
      const self = trainee(state);
      self.inventory = [...MISSION_ITEMS];
      self.itemsFound = MISSION_ITEMS.length;
      self.room = state.sim.map.exitRoom;
      self.x = ROOM_W / 2;
      self.y = ROOM_H / 2;
      self.busy = null;
      dummy(state).room = (state.sim.map.exitRoom + 4) % 9;
    },
    done: state => state.sim.finished || state.finished,
  },
]);

export function startTutorial(now = 0): TutorialState {
  const sim = createMatch(TUTORIAL_SEED, [
    { playerId: TRAINEE, friendId: "1", codename: "RECRUIT", genesis: false, kitId: "field" },
    { playerId: DUMMY, friendId: "2", codename: "MANNEQUIN", genesis: false, kitId: "field" },
  ], now);
  // The dummy is scenery: it never acts, and it is parked out of the way until it is needed.
  const target = sim.players.get(DUMMY)!;
  target.room = 8;
  const state: TutorialState = {
    sim, index: 0, finished: false, travelled: 0,
    roomAtEntry: sim.players.get(TRAINEE)!.room, searches: 0, shownMs: 0, entered: false,
  };
  return state;
}

export const lessonOf = (state: TutorialState): Lesson | null => LESSONS[state.index] ?? null;

/**
 * Advances the rehearsal. Mirrors one server tick: apply input, step the sim, then check the
 * current lesson. Staging for a lesson runs once, on the first tick after it becomes current.
 */
export function stepTutorial(state: TutorialState, deltaMs: number, dx: number, dy: number): void {
  if (state.finished) return;
  const lesson = lessonOf(state);
  if (lesson && !state.entered) {
    state.entered = true;
    state.roomAtEntry = trainee(state).room;
    state.travelled = 0;
    state.shownMs = 0;
    lesson.enter?.(state);
  }
  state.shownMs += deltaMs;
  lesson?.tick?.(state);

  const self = trainee(state);
  const beforeX = self.x;
  const beforeY = self.y;
  const searchedBefore = countSearched(state);

  // Sequence numbers must strictly increase, and tick is still on the previous value here.
  const seq = state.sim.tick + 1;
  applyInput(state.sim, TRAINEE, seq, dx, dy);
  // The dummy never moves; keeping its input clear stops it drifting if it is ever nudged.
  applyInput(state.sim, DUMMY, seq, 0, 0);
  stepMatch(state.sim, deltaMs);

  state.travelled += Math.hypot(trainee(state).x - beforeX, trainee(state).y - beforeY);
  state.searches += Math.max(0, countSearched(state) - searchedBefore);

  // The rehearsal has no clock pressure; keep pushing the deadline out of reach.
  if (state.sim.endsAt - state.sim.now < 60_000) state.sim.endsAt = state.sim.now + 600_000;

  if (lesson && state.shownMs >= LESSON_DWELL_MS && lesson.done(state)) advanceTutorial(state);
}

function countSearched(state: TutorialState): number {
  let total = 0;
  for (const room of state.sim.map.rooms) for (const piece of room.furniture) {
    if (piece.searched) total++;
  }
  return total;
}

export function advanceTutorial(state: TutorialState): void {
  if (state.index >= LESSONS.length - 1) {
    state.finished = true;
    return;
  }
  state.index++;
  state.entered = false;
  state.shownMs = 0;
}

/** Actions from the trainee go straight to the sim; the escape lesson also ends the run. */
export function tutorialAction(state: TutorialState, action: PlayerAction): void {
  if (state.finished) return;
  applyAction(state.sim, TRAINEE, action);
  if (action.kind === "escape" && state.sim.finished) state.finished = true;
}

export function tutorialSnapshot(state: TutorialState): MatchSnapshot {
  return buildSnapshot(state.sim, TRAINEE);
}

/** The threshold point of a doorway, re-exported so callers need not reach into the sim. */
export const doorAnchorOf = doorAnchor;
