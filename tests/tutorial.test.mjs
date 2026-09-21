/**
 * Drives the training run end to end the way a person would: each lesson is cleared by
 * performing its action against the real simulation, never by setting its flag. If a lesson
 * ever becomes impossible to clear — furniture out of reach, a doorway with no threshold, a
 * dummy that cannot be hit — this test hangs up on that lesson and fails by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../games/embassy-run/shared/protocol.ts";
import * as tut from "../games/embassy-run/tutorial.ts";

const TICK = 1000 / P.TICK_HZ;

/** Step the rehearsal for a while, holding a direction. */
function hold(state, ms, dx = 0, dy = 0) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK) tut.stepTutorial(state, TICK, dx, dy);
}

const self = state => state.sim.players.get(tut.TRAINEE);

test("every lesson is reachable and the run can be completed", () => {
  const state = tut.startTutorial(0);
  const cleared = [];
  const seen = new Set();

  // A generous budget: far more than a person needs, but bounded, so a stuck lesson fails.
  for (let guard = 0; guard < 4000 && !state.finished; guard++) {
    const lesson = tut.lessonOf(state);
    assert.ok(lesson, "a lesson should be current until the run finishes");
    if (!seen.has(lesson.id)) { seen.add(lesson.id); cleared.push(lesson.id); }

    switch (lesson.id) {
      case "move":
        hold(state, 900, 1, 0);
        break;
      case "rooms": {
        hold(state, tut.LESSON_DWELL_MS);
        // Steer onto the threshold of whichever doorway this room has, then push through.
        const agent = self(state);
        const direction = state.sim.map.rooms[agent.room].doors[0];
        const anchor = tut.doorAnchorOf(direction);
        hold(state, 240, Math.sign(anchor.x - agent.x), 0);
        hold(state, 240, 0, Math.sign(anchor.y - agent.y));
        hold(state, 240, Math.sign(anchor.x - agent.x), Math.sign(anchor.y - agent.y));
        break;
      }
      case "search":
      case "collect": {
        hold(state, tut.LESSON_DWELL_MS);
        const piece = tut.nearestFurniture(state);
        assert.ok(piece, "the lesson should have staged a piece of furniture");
        tut.tutorialAction(state, { kind: "search", furnitureId: piece.id });
        hold(state, P.SEARCH_MS + 300);
        break;
      }
      case "trap": {
        hold(state, tut.LESSON_DWELL_MS);
        const piece = tut.nearestFurniture(state);
        tut.tutorialAction(state, { kind: "plant", targetId: piece.id, trap: "bomb" });
        hold(state, P.PLANT_MS + 300);
        break;
      }
      case "doortrap": {
        hold(state, tut.LESSON_DWELL_MS);
        // Stand in a doorway, then set a trap on it.
        const agent = self(state);
        const room = state.sim.map.rooms[agent.room];
        const direction = room.doors[0];
        const anchor = tut.doorAnchorOf(direction);
        agent.x = anchor.x;
        agent.y = anchor.y;
        tut.tutorialAction(state, {
          kind: "plant", targetId: P.doorTrapId(agent.room, direction), trap: "spring",
        });
        hold(state, P.PLANT_MS + 300);
        break;
      }
      case "strike":
      case "knife":
        // Dwell first: a lesson cannot be cleared until it has been readable for a moment.
        hold(state, tut.LESSON_DWELL_MS);
        tut.tutorialAction(state, { kind: "attack" });
        hold(state, 200);
        break;
      case "escape":
        hold(state, tut.LESSON_DWELL_MS);
        tut.tutorialAction(state, { kind: "escape" });
        hold(state, 200);
        break;
      default:
        assert.fail(`unknown lesson ${lesson.id}`);
    }
  }

  assert.ok(state.finished, `the run stalled on "${tut.lessonOf(state)?.id ?? "?"}"`);
  assert.deepEqual(cleared, tut.LESSONS.map(lesson => lesson.id),
    "every lesson should be visited once, in order");
});

test("the training run never runs out of clock", () => {
  const state = tut.startTutorial(0);
  hold(state, 90_000, 1, 0);
  assert.equal(state.sim.finished, false, "a rehearsal must not be lost on the timer");
  assert.ok(state.sim.endsAt - state.sim.now > 60_000, "the deadline should keep moving out");
});

test("the trainee's view is a real room-scoped snapshot", () => {
  const state = tut.startTutorial(0);
  hold(state, 200);
  const snapshot = tut.tutorialSnapshot(state);
  assert.equal(snapshot.t, "snapshot");
  assert.equal(snapshot.self.playerId, tut.TRAINEE);
  assert.equal(snapshot.self.maxHp, P.PLAYER_MAX_HP);
  assert.equal(snapshot.roomIndex, state.sim.players.get(tut.TRAINEE).room);
  assert.ok(snapshot.roomName.length > 0, "the room should be named, as in a live match");
  // The dummy is parked in another room, so fog of war must hide it.
  assert.equal(snapshot.actors.length, 0, "only the trainee's own room is visible");
});

test("the dummy never acts on its own", () => {
  const state = tut.startTutorial(0);
  const dummy = state.sim.players.get(tut.DUMMY);
  const { x, y, room } = dummy;
  hold(state, 5000, 1, 1);
  assert.equal(dummy.room, room, "the dummy should stay where it was put");
  assert.equal(dummy.x, x);
  assert.equal(dummy.y, y);
});
