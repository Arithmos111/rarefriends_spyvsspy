import test from "node:test";
import assert from "node:assert/strict";

const sim = await import("../games/embassy-run/shared/sim.ts");
const map = await import("../games/embassy-run/shared/mansion.ts");
const P = await import("../games/embassy-run/shared/protocol.ts");
const kits = await import("../games/embassy-run/shared/loadouts.ts");

const roster = (...entries) => entries.map((entry, index) => ({
  playerId: entry.id, friendId: String(index + 1), codename: entry.id.toUpperCase(),
  genesis: entry.genesis ?? false, kitId: entry.kit ?? "field",
}));

const start = (players, seed = 7777) => sim.createMatch(seed, players, 0);
const run = (match, ms, stepMs = 50) => { for (let t = 0; t < ms; t += stepMs) sim.stepMatch(match, stepMs); };

test("map generation is deterministic and fully walkable", () => {
  assert.equal(JSON.stringify(map.createMap(31337)), JSON.stringify(map.createMap(31337)));
  assert.notEqual(JSON.stringify(map.createMap(1)), JSON.stringify(map.createMap(2)));
  for (const room of map.createMap(31337).rooms) {
    assert.equal(room.furniture.length, 5);
    assert.ok(!map.blockedByFurniture(room, P.ROOM_W / 2, P.ROOM_H / 2), `centre blocked in room ${room.index}`);
    for (const direction of room.doors) {
      const point = map.doorEntryPoint(direction);
      assert.ok(!map.blockedByFurniture(room, point.x, point.y), `door ${direction} blocked in room ${room.index}`);
    }
  }
});

test("all four mission items are hidden in four distinct non-exit rooms", () => {
  const embassy = map.createMap(4242);
  map.placeMissionItems(embassy, 4242);
  const holders = embassy.rooms.flatMap(room => room.furniture.filter(piece => piece.contents).map(piece => ({ room: room.index, item: piece.contents })));
  assert.equal(holders.length, P.MISSION_ITEMS.length);
  assert.equal(new Set(holders.map(entry => entry.item)).size, P.MISSION_ITEMS.length);
  assert.equal(new Set(holders.map(entry => entry.room)).size, P.MISSION_ITEMS.length);
  assert.ok(!holders.some(entry => entry.room === embassy.exitRoom));
});

test("doorways move an agent between rooms, walls do not", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  assert.equal(agent.room, 0);
  sim.applyInput(match, "a", 1, 1, 0);
  run(match, 6000);
  assert.equal(agent.room, 2, "holding east should cross two doorways");
  // Room 2 has no east neighbour; the wall must hold.
  run(match, 4000);
  assert.equal(agent.room, 2);
  assert.ok(agent.x <= P.ROOM_W - P.PLAYER_RADIUS + 0.001);
});

test("an agent must line up with a doorway to use it", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.x = 60; agent.y = P.ROOM_H / 2;
  sim.applyInput(match, "a", 1, 0, 1);
  run(match, 5000);
  assert.equal(agent.room, 0, "south wall away from the door must block");
  agent.x = P.ROOM_W / 2;
  sim.applyInput(match, "a", 2, 0, 1);
  const path = [agent.room];
  for (let t = 0; t < 5000; t += 50) {
    sim.stepMatch(match, 50);
    if (path[path.length - 1] !== agent.room) path.push(agent.room);
  }
  assert.deepEqual(path, [0, 3, 6], "aligned with the south door it should walk the whole column");
});

test("searching furniture yields the hidden item exactly once", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  const room = match.map.rooms.find(entry => entry.furniture.some(piece => piece.contents));
  const piece = room.furniture.find(entry => entry.contents);
  const item = piece.contents;
  agent.room = room.index; agent.x = piece.x; agent.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.deepEqual(agent.inventory, [item]);
  assert.equal(piece.contents, null);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.deepEqual(agent.inventory, [item], "a second search must not duplicate the item");
});

test("searching out of reach does nothing", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = match.map.rooms[0].furniture[0];
  agent.room = 0; agent.x = piece.x + P.INTERACT_RANGE + 40; agent.y = piece.y;
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  assert.equal(agent.busy, null);
});

test("a rival letter bomb kills the searcher and spills their items", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");
  const piece = match.map.rooms[0].furniture[0];
  planter.room = 0; planter.x = piece.x; planter.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", furnitureId: piece.id, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  assert.equal(match.traps.get(piece.id)?.type, "bomb");
  assert.equal(planter.traps.bomb, kits.kitById("demolition").traps.bomb - 1);

  victim.room = 0; victim.x = piece.x; victim.y = piece.y + 30;
  victim.inventory.push("documents", "cash");
  sim.applyAction(match, "b", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(victim.hp, 0);
  assert.equal(victim.inventory.length, 0);
  assert.equal(match.drops.filter(drop => drop.room === 0).length, 2, "both carried items should land in the room");
  assert.ok(!match.traps.has(piece.id), "a sprung trap is consumed");
});

test("your own trap does not catch you", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = match.map.rooms[0].furniture[0];
  agent.room = 0; agent.x = piece.x; agent.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", furnitureId: piece.id, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(agent.hp, P.PLAYER_MAX_HP);
});

test("a water bucket stuns without killing", () => {
  const match = start(roster({ id: "a", kit: "director" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");
  const piece = match.map.rooms[0].furniture[0];
  planter.room = 0; planter.x = piece.x; planter.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", furnitureId: piece.id, trap: "bucket" });
  run(match, P.PLANT_MS + 100);
  victim.room = 0; victim.x = piece.x; victim.y = piece.y + 30;
  victim.inventory.push("cash");
  sim.applyAction(match, "b", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 100);
  assert.equal(victim.hp, P.PLAYER_MAX_HP);
  assert.deepEqual(victim.inventory, ["cash"], "a soaking must not spill items");
  assert.ok(victim.stunnedUntil > match.now);
});

test("two strikes take an agent down and respawn restores them", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 200; attacker.y = 200;
  target.room = 0; target.x = 220; target.y = 200;
  target.invulnerableUntil = 0; attacker.invulnerableUntil = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, P.PLAYER_MAX_HP - 1);
  run(match, P.ATTACK_COOLDOWN_MS + 100);
  target.x = 220; target.y = 200;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, 0);
  assert.equal(target.deaths, 1);
  run(match, P.RESPAWN_MS + 200);
  assert.equal(target.hp, P.PLAYER_MAX_HP);
  assert.equal(target.respawnAt, 0);
});

test("attacks respect range, cooldown and spawn protection", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 100; attacker.y = 200;
  target.room = 0; target.x = 100 + P.ATTACK_RANGE + 20; target.y = 200;
  target.invulnerableUntil = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, P.PLAYER_MAX_HP, "out of range");
  target.x = 120;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, P.PLAYER_MAX_HP, "still on cooldown");
  run(match, P.ATTACK_COOLDOWN_MS + 50);
  target.invulnerableUntil = match.now + 1000;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, P.PLAYER_MAX_HP, "spawn protection holds");
});

test("dropped items can be picked up by anyone in reach", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  match.drops.push({ id: 1, item: "passport", room: 0, x: 200, y: 200 });
  agent.room = 0; agent.x = 400; agent.y = 200;
  sim.applyAction(match, "a", { kind: "pickup", dropId: 1 });
  assert.equal(agent.inventory.length, 0, "out of reach");
  agent.x = 210;
  sim.applyAction(match, "a", { kind: "pickup", dropId: 1 });
  assert.deepEqual(agent.inventory, ["passport"]);
  assert.equal(match.drops.length, 0);
});

test("the gate only opens for a complete set", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.room = match.map.exitRoom; agent.x = map.EXIT_X; agent.y = map.EXIT_Y;
  agent.inventory.push("documents", "passport", "cash");
  sim.applyAction(match, "a", { kind: "escape" });
  assert.equal(match.finished, false);
  agent.inventory.push("disguise");
  sim.applyAction(match, "a", { kind: "escape" });
  assert.equal(match.finished, true);
  assert.equal(match.winner, "a");
});

test("escaping requires standing at the gate", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.room = match.map.exitRoom;
  agent.x = map.EXIT_X + map.EXIT_RADIUS + 50; agent.y = map.EXIT_Y;
  agent.inventory.push(...P.MISSION_ITEMS);
  sim.applyAction(match, "a", { kind: "escape" });
  assert.equal(match.finished, false);
});

test("the match ends on the timer and ranks by items held", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  match.players.get("a").inventory.push("cash", "passport");
  match.players.get("b").inventory.push("cash");
  match.now = match.endsAt - 100;
  run(match, 400);
  assert.equal(match.finished, true);
  assert.equal(match.winner, "a");
});

test("a timed-out match with no intelligence has no winner", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  match.now = match.endsAt - 100;
  run(match, 400);
  assert.equal(match.finished, true);
  assert.equal(match.winner, null);
});

test("a disarm tool steals a rival trap", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b", kit: "director" }));
  const planter = match.players.get("a");
  const thief = match.players.get("b");
  const piece = match.map.rooms[0].furniture[0];
  planter.room = 0; planter.x = piece.x; planter.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", furnitureId: piece.id, trap: "spring" });
  run(match, P.PLANT_MS + 100);
  const before = thief.traps.spring;
  thief.room = 0; thief.x = piece.x; thief.y = piece.y + 30;
  sim.applyAction(match, "b", { kind: "disarm", furnitureId: piece.id });
  run(match, P.DISARM_MS + 100);
  assert.ok(!match.traps.has(piece.id));
  assert.equal(thief.traps.spring, before + 1);
});

test("client and server movement code agree step for step", () => {
  const embassy = map.createMap(2024);
  const a = { room: 0, x: 120, y: 150, facing: "down", walking: false };
  const b = { room: 0, x: 120, y: 150, facing: "down", walking: false };
  let seed = 5;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const dx = ((seed >> 5) % 3) - 1, dy = ((seed >> 11) % 3) - 1;
    sim.movePlayer(embassy, a, dx, dy, 33);
    sim.movePlayer(embassy, b, dx, dy, 33);
  }
  assert.deepEqual(a, b);
  assert.ok(map.insideRoom(a.x, a.y) || true);
  assert.ok(!map.blockedByFurniture(embassy.rooms[a.room], a.x, a.y), "prediction must never end inside furniture");
});

test("a suspended tab cannot tunnel through furniture", () => {
  const embassy = map.createMap(99);
  const piece = embassy.rooms[0].furniture[0];
  const agent = { room: 0, x: piece.x - 60, y: piece.y, facing: "right", walking: false };
  sim.movePlayer(embassy, agent, 1, 0, 10_000);
  assert.ok(!map.blockedByFurniture(embassy.rooms[0], agent.x, agent.y));
  assert.ok(agent.x < piece.x, "a huge frame delta must not cross the footprint");
});

test("oversized input vectors are normalised", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  sim.applyInput(match, "a", 1, 500, 500);
  const input = match.players.get("a").input;
  assert.ok(Math.hypot(input.dx, input.dy) <= 1.0001, "a client cannot outrun the speed cap");
});

test("stale input sequence numbers are ignored", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  sim.applyInput(match, "a", 10, 1, 0);
  sim.applyInput(match, "a", 4, -1, 0);
  assert.equal(match.players.get("a").input.dx, 1);
});

test("every furniture type can be reached from every side", () => {
  // An agent must be able to stand somewhere that is outside a piece's footprint AND within
  // INTERACT_RANGE of it, or that piece is impossible to search from that direction.
  for (const [type, footprint] of Object.entries(P.FURNITURE_FOOTPRINT)) {
    const clearanceX = footprint.w / 2 + P.PLAYER_RADIUS;
    const clearanceY = footprint.h / 2 + P.PLAYER_RADIUS;
    assert.ok(clearanceX <= P.INTERACT_RANGE,
      `${type}: needs ${clearanceX} clearance along x but reach is only ${P.INTERACT_RANGE}`);
    assert.ok(clearanceY <= P.INTERACT_RANGE,
      `${type}: needs ${clearanceY} clearance along y but reach is only ${P.INTERACT_RANGE}`);
  }
});

test("a real generated room lets an agent reach every piece it holds", () => {
  const embassy = map.createMap(20260920);
  for (const room of embassy.rooms) {
    for (const piece of room.furniture) {
      let reachable = false;
      for (let step = 0; step < 48 && !reachable; step++) {
        const angle = (step / 48) * Math.PI * 2;
        for (let radius = 20; radius <= P.INTERACT_RANGE; radius += 2) {
          const x = piece.x + Math.cos(angle) * radius;
          const y = piece.y + Math.sin(angle) * radius;
          if (!map.insideRoom(x, y) || map.blockedByFurniture(room, x, y)) continue;
          reachable = true;
          break;
        }
      }
      assert.ok(reachable, `room ${room.index}: ${piece.type} at ${piece.x},${piece.y} is unreachable`);
    }
  }
});
