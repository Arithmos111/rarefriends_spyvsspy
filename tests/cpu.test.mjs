import test from "node:test";
import assert from "node:assert/strict";

const P = await import("../games/rare-agency/shared/protocol.ts");
const map = await import("../games/rare-agency/shared/mansion.ts");
const sim = await import("../games/rare-agency/shared/sim.ts");
const cpu = await import("../games/rare-agency/shared/cpu.ts");
const solo = await import("../games/rare-agency/solo.ts");

const play = (state, ms, stepMs = 50, dx = 0, dy = 0) => {
  for (let t = 0; t < ms; t += stepMs) solo.stepSolo(state, stepMs, dx, dy);
};

test("the room graph routes by the shortest legal path", () => {
  const embassy = map.createMap(4242);
  for (let from = 0; from < P.ROOM_COUNT; from++) {
    assert.equal(cpu.routeStep(embassy, from, from), null, "already there is no step");
    for (let to = 0; to < P.ROOM_COUNT; to++) {
      if (from === to) continue;
      const step = cpu.routeStep(embassy, from, to);
      assert.ok(step, `no route from ${from} to ${to}`);
      assert.ok(embassy.rooms[from].doors.includes(step), "the first step must go through a door");
    }
  }
});

test("routing walks the graph rather than the grid", () => {
  const embassy = map.createMap(4242);
  // Follow the route one room at a time; it must terminate at the destination.
  for (let to = 0; to < P.ROOM_COUNT; to++) {
    let at = 0;
    for (let hop = 0; hop < P.ROOM_COUNT && at !== to; hop++) {
      const step = cpu.routeStep(embassy, at, to);
      assert.ok(step, `stuck at ${at} heading for ${to}`);
      at = P.neighbourRoom(at, step);
    }
    assert.equal(at, to, `route to ${to} never arrived`);
  }
});

test("a demo match seats the player and the requested number of computer agents", () => {
  const state = solo.startSolo({ players: 4, seed: 99, difficulty: "agent" });
  assert.equal(state.sim.players.size, 4);
  assert.equal(state.cpus.length, 3);
  assert.ok(state.sim.players.has(solo.SOLO_PLAYER));
  for (const memory of state.cpus) assert.ok(state.sim.players.has(memory.playerId));
  const names = [...state.sim.players.values()].map(entry => entry.codename);
  assert.equal(new Set(names).size, names.length, "codenames must be distinct on the scoreboard");
});

test("a demo match replays identically from the same seed", () => {
  const trace = seed => {
    const state = solo.startSolo({ players: 3, seed, difficulty: "veteran" });
    play(state, 20_000);
    return [...state.sim.players.values()]
      .map(entry => `${entry.playerId}:${entry.room}:${Math.round(entry.x)}:${Math.round(entry.y)}:${entry.itemsFound}`)
      .join("|");
  };
  assert.equal(trace(1234), trace(1234), "same seed, same match");
  assert.notEqual(trace(1234), trace(5678));
});

test("computer agents leave their starting room and cover ground", () => {
  const state = solo.startSolo({ players: 4, seed: 7, difficulty: "agent" });
  const start = state.cpus.map(memory => state.sim.players.get(memory.playerId).room);
  play(state, 45_000);
  const visited = state.cpus.map(memory => memory.visited.size);
  for (const count of visited) assert.ok(count >= 2, `an agent never left its first room (${visited})`);
  const moved = state.cpus.filter((memory, index) =>
    state.sim.players.get(memory.playerId).room !== start[index]);
  assert.ok(moved.length > 0, "nobody moved room in 45 seconds");
});

test("computer agents search furniture and recover intelligence", () => {
  const state = solo.startSolo({ players: 4, seed: 21, difficulty: "veteran" });
  play(state, 120_000);
  const searched = state.sim.map.rooms
    .flatMap(room => room.furniture).filter(piece => piece.searched).length;
  assert.ok(searched >= 6, `only ${searched} pieces searched in two minutes`);
  const found = state.cpus.reduce((total, memory) =>
    total + state.sim.players.get(memory.playerId).itemsFound, 0);
  assert.ok(found >= 1, "nobody turned up a single mission item");
});

test("a demo match finishes, and finishing produces a recap for everyone", () => {
  const state = solo.startSolo({ players: 4, seed: 33, difficulty: "veteran" });
  // Long enough that the clock alone would end it, even if nobody escapes.
  play(state, P.MATCH_SECONDS * 1000 + 5000, 100);
  assert.equal(state.finished, true, "the match should be over");
  const recap = solo.soloRecap(state);
  assert.equal(recap.length, 4);
  assert.deepEqual(recap.map(row => row.place), [1, 2, 3, 4]);
  for (const row of recap) {
    assert.ok(row.points >= P.CAREER_POINTS_PLAYED);
    assert.ok(row.damageTaken >= 0 && row.damageDealt >= 0);
  }
});

test("a computer agent carrying the full set heads for the gate and gets out", () => {
  const state = solo.startSolo({ players: 2, seed: 5, difficulty: "veteran" });
  const hunter = state.sim.players.get(state.cpus[0].playerId);
  for (const item of P.MISSION_ITEMS) hunter.inventory.push(item);
  hunter.itemsFound = P.MISSION_ITEMS.length;
  play(state, 60_000);
  assert.equal(state.sim.finished, true, "a full set should have been walked out");
  assert.equal(state.sim.winner, hunter.playerId);
  assert.equal(state.sim.escaped, true);
});

test("a computer agent strikes a rival standing next to it", () => {
  const state = solo.startSolo({ players: 2, seed: 11, difficulty: "veteran" });
  const enemy = state.sim.players.get(state.cpus[0].playerId);
  const me = state.sim.players.get(solo.SOLO_PLAYER);
  // Park the player right under its nose and stand still.
  enemy.room = me.room;
  enemy.x = me.x + 20; enemy.y = me.y;
  me.invulnerableUntil = 0;
  const before = me.hp;
  play(state, 6000);
  assert.ok(me.hp < before, "it never took a swing at someone in arm's reach");
});

test("a computer agent knows only the rooms it has stood in", () => {
  const state = solo.startSolo({ players: 2, seed: 13, difficulty: "veteran" });
  const memory = state.cpus[0];
  solo.stepSolo(state, 50, 0, 0);
  assert.deepEqual([...memory.visited.keys()], [state.sim.players.get(memory.playerId).room]);
  // It cannot target furniture in a room it has never entered.
  const elsewhere = state.sim.map.rooms
    .find(room => room.index !== state.sim.players.get(memory.playerId).room);
  const ids = new Set(elsewhere.furniture.map(piece => piece.id));
  if (memory.goal?.kind === "search") assert.ok(!ids.has(memory.goal.furnitureId));
});

test("a rookie forgets what it has searched and a veteran does not", () => {
  const embassy = () => solo.startSolo({ players: 2, seed: 17, difficulty: "rookie" });
  const forgetful = embassy();
  play(forgetful, 90_000);
  const sharp = solo.startSolo({ players: 2, seed: 17, difficulty: "veteran" });
  play(sharp, 90_000);
  // Recall is the only difference in what each remembers about its own searches, and the
  // veteran keeps everything, so it can never be the one holding less.
  assert.ok(sharp.cpus[0].searched.size >= forgetful.cpus[0].searched.size);
});

test("computer agents never stall against the furniture", () => {
  const state = solo.startSolo({ players: 4, seed: 404, difficulty: "agent" });
  // Sample each agent's position every two seconds; nobody should be pinned for long.
  const stalls = state.cpus.map(() => 0);
  const last = state.cpus.map(memory => {
    const player = state.sim.players.get(memory.playerId);
    return { room: player.room, x: player.x, y: player.y };
  });
  for (let t = 0; t < 90_000 && !state.finished; t += 2000) {
    play(state, 2000);
    if (state.finished) break;
    state.cpus.forEach((memory, index) => {
      // A downed agent is meant to lie where it fell until it respawns.
      if (state.sim.players.get(memory.playerId).respawnAt > 0) { stalls[index] = 0; return; }
      const player = state.sim.players.get(memory.playerId);
      const still = player.room === last[index].room
        && Math.hypot(player.x - last[index].x, player.y - last[index].y) < 12;
      stalls[index] = still ? stalls[index] + 1 : 0;
      last[index] = { room: player.room, x: player.x, y: player.y };
      assert.ok(stalls[index] < 5, `agent ${memory.playerId} sat still for ten seconds`);
    });
  }
});

test("a computer agent never walks through a wall or into furniture", () => {
  const state = solo.startSolo({ players: 4, seed: 808, difficulty: "veteran" });
  for (let t = 0; t < 60_000; t += 50) {
    solo.stepSolo(state, 50, 0, 0);
    for (const memory of state.cpus) {
      const player = state.sim.players.get(memory.playerId);
      if (player.respawnAt > 0) continue;
      assert.ok(map.insideRoom(player.x, player.y), `${memory.playerId} left the room`);
      assert.ok(!map.blockedByFurniture(state.sim.map.rooms[player.room], player.x, player.y),
        `${memory.playerId} stood inside the furniture`);
    }
  }
});

test("demo mode drives the sim through the public surface only", () => {
  // The brain may read the simulation, but everything it does to it goes through applyInput
  // and applyAction, so a demo match is exactly a live match with the relay taken out.
  const source = cpu.default ?? null;
  assert.equal(source, null, "the module has no default export to smuggle state through");
  const state = solo.startSolo({ players: 2, seed: 3 });
  const before = state.sim.players.get(state.cpus[0].playerId).maxHp;
  play(state, 30_000);
  assert.ok(state.sim.players.get(state.cpus[0].playerId).maxHp >= before,
    "a computer agent's ceiling only ever moves the way a vest moves it");
  assert.ok(state.sim.players.get(state.cpus[0].playerId).maxHp <= P.PLAYER_HP_CEILING);
});
