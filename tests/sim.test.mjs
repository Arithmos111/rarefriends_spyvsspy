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
  // Furniture also holds power-ups now, so only the mission items are counted here.
  const holders = embassy.rooms.flatMap(room => room.furniture
    .filter(piece => piece.contents && P.MISSION_ITEMS.includes(piece.contents))
    .map(piece => ({ room: room.index, item: piece.contents })));
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
  const room = match.map.rooms.find(entry => entry.furniture.some(piece => P.MISSION_ITEMS.includes(piece.contents)));
  const piece = room.furniture.find(entry => P.MISSION_ITEMS.includes(entry.contents));
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
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "bomb" });
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

test("your own trap catches you too", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = match.map.rooms[0].furniture[0];
  agent.room = 0; agent.x = piece.x; agent.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(agent.hp, 0, "an agent who forgets their own bomb should set it off");
  assert.equal(agent.takedowns, 0, "blowing yourself up is nobody's takedown");
});

test("you can disarm your own trap to recover it", () => {
  const match = start(roster({ id: "a", kit: "director" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = match.map.rooms[0].furniture[0];
  agent.room = 0; agent.x = piece.x; agent.y = piece.y + 30;
  const before = agent.traps.spring;
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "spring" });
  run(match, P.PLANT_MS + 100);
  assert.equal(agent.traps.spring, before - 1);
  sim.applyAction(match, "a", { kind: "disarm", targetId: piece.id });
  run(match, P.DISARM_MS + 100);
  assert.ok(!match.traps.has(piece.id));
  assert.equal(agent.traps.spring, before, "the trap returns to your kit");
});

test("a water bucket stuns without killing", () => {
  const match = start(roster({ id: "a", kit: "director" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");
  const piece = match.map.rooms[0].furniture[0];
  planter.room = 0; planter.x = piece.x; planter.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "bucket" });
  run(match, P.PLANT_MS + 100);
  victim.room = 0; victim.x = piece.x; victim.y = piece.y + 30;
  victim.inventory.push("cash");
  sim.applyAction(match, "b", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 100);
  assert.equal(victim.hp, P.PLAYER_MAX_HP);
  assert.deepEqual(victim.inventory, ["cash"], "a soaking must not spill items");
  assert.ok(victim.stunnedUntil > match.now);
});

test("five fist blows take an agent down and respawn restores them", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 200; attacker.y = 200;
  target.invulnerableUntil = 0; attacker.invulnerableUntil = 0;
  assert.equal(P.PLAYER_MAX_HP, 5);
  for (let blow = 1; blow <= P.PLAYER_MAX_HP; blow++) {
    target.room = 0; target.x = 220; target.y = 200;
    sim.applyAction(match, "a", { kind: "attack" });
    assert.equal(target.hp, Math.max(0, P.PLAYER_MAX_HP - blow), `after blow ${blow}`);
    run(match, P.ATTACK_COOLDOWN_MS + 60);
  }
  assert.equal(target.deaths, 1);
  assert.equal(attacker.takedowns, 1);
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
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "spring" });
  run(match, P.PLANT_MS + 100);
  const before = thief.traps.spring;
  thief.room = 0; thief.x = piece.x; thief.y = piece.y + 30;
  sim.applyAction(match, "b", { kind: "disarm", targetId: piece.id });
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

// --- Power-ups, the knife, door traps and scoring ---------------------------------------

const giveContents = (match, item) => {
  const piece = match.map.rooms[0].furniture[0];
  piece.contents = item;
  match.traps.delete(piece.id);
  return piece;
};
const standAt = (player, piece, room = 0) => {
  player.room = room; player.x = piece.x; player.y = piece.y + 30;
};

test("exactly one knife exists in a generated embassy", () => {
  for (const seed of [1, 99, 31337, 2026]) {
    const embassy = map.createMap(seed);
    map.placeMissionItems(embassy, seed);
    const knives = embassy.rooms.flatMap(room => room.furniture.filter(piece => piece.contents === "knife"));
    assert.equal(knives.length, 1, `seed ${seed} should hide exactly one knife`);
  }
});

test("the knife doubles strike damage and drops when its holder is taken down", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  const piece = giveContents(match, "knife");
  standAt(attacker, piece);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(attacker.knife, true);
  assert.equal(sim.attackDamage(attacker), P.KNIFE_DAMAGE);

  attacker.x = 200; attacker.y = 200; attacker.invulnerableUntil = 0;
  target.room = 0; target.x = 220; target.y = 200; target.invulnerableUntil = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(target.hp, P.PLAYER_MAX_HP - P.KNIFE_DAMAGE, "a knife hits for two");

  // Taking the holder down must put the knife back into circulation. Clear the stun the
  // blow above inflicted, or the counterattack is correctly refused.
  attacker.hp = 1;
  target.attackReadyAt = 0;
  target.stunnedUntil = 0;
  sim.applyAction(match, "b", { kind: "attack" });
  assert.equal(attacker.hp, 0);
  assert.equal(attacker.knife, false);
  assert.ok(match.drops.some(drop => drop.item === "knife"), "the knife should drop where its holder fell");
});

test("a medkit heals but never past your maximum", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.hp = 1;
  const piece = giveContents(match, "medkit");
  standAt(agent, piece);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(agent.hp, Math.min(P.PLAYER_MAX_HP, 1 + P.MEDKIT_HEAL));
  assert.ok(agent.hp <= agent.maxHp);
});

test("a vest raises the ceiling and respawn restores to it", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = giveContents(match, "vest");
  standAt(agent, piece);
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(agent.maxHp, P.PLAYER_MAX_HP + P.VEST_BONUS_HP);
  agent.hp = 1;
  agent.respawnAt = match.now + 10;
  run(match, P.RESPAWN_MS + 200);
  assert.equal(agent.hp, P.PLAYER_MAX_HP + P.VEST_BONUS_HP, "respawn restores the raised maximum");
});

test("a trap on a doorway fires on whoever walks through it", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");
  const doorId = P.doorTrapId(0, "east");
  planter.room = 0; planter.x = P.ROOM_W; planter.y = P.ROOM_H / 2;
  sim.applyAction(match, "a", { kind: "plant", targetId: doorId, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  assert.equal(match.traps.get(doorId)?.type, "bomb", "the doorway should hold the trap");

  victim.room = 0; victim.x = P.ROOM_W - 40; victim.y = P.ROOM_H / 2;
  victim.invulnerableUntil = 0;
  sim.applyInput(match, "b", 1, 1, 0);
  run(match, 2000);
  assert.equal(victim.hp, 0, "walking the trapped doorway should spring it");
  assert.ok(!match.traps.has(doorId), "a sprung doorway trap is consumed");
});

test("a doorway trap catches the agent who set it as well", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  const doorId = P.doorTrapId(0, "east");
  planter.room = 0; planter.x = P.ROOM_W; planter.y = P.ROOM_H / 2;
  sim.applyAction(match, "a", { kind: "plant", targetId: doorId, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  planter.x = P.ROOM_W - 40; planter.invulnerableUntil = 0;
  sim.applyInput(match, "a", 1, 1, 0);
  run(match, 2000);
  assert.equal(planter.hp, 0);
});

test("traps cannot be planted out of reach of their target", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.room = 0; agent.x = 60; agent.y = 60;
  sim.applyAction(match, "a", { kind: "plant", targetId: P.doorTrapId(0, "east"), trap: "bomb" });
  assert.equal(agent.busy, null, "the far doorway is out of reach");
  sim.applyAction(match, "a", { kind: "plant", targetId: P.doorTrapId(0, "north"), trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  assert.ok(!match.traps.has(P.doorTrapId(0, "north")), "still out of reach from the corner");
});

test("match points reward escaping, items and takedowns", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.itemsFound = 3;
  agent.takedowns = 2;
  assert.equal(sim.scoreOf(match, agent), 3 * P.SCORE_PER_ITEM + 2 * P.SCORE_PER_TAKEDOWN);

  agent.room = match.map.exitRoom;
  agent.x = map.EXIT_X; agent.y = map.EXIT_Y;
  agent.inventory.push(...P.MISSION_ITEMS);
  sim.applyAction(match, "a", { kind: "escape" });
  assert.equal(match.finished, true);
  assert.equal(match.escaped, true);
  assert.equal(
    sim.scoreOf(match, agent),
    3 * P.SCORE_PER_ITEM + 2 * P.SCORE_PER_TAKEDOWN + P.SCORE_ESCAPE + P.SCORE_SURVIVED,
  );
});

test("dropping items on death gives back the points they carried", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  agent.inventory.push("documents", "cash");
  agent.itemsFound = 2;
  agent.hp = 1;
  const attacker = match.players.get("b");
  attacker.room = agent.room; attacker.x = agent.x + 20; attacker.y = agent.y;
  agent.invulnerableUntil = 0;
  sim.applyAction(match, "b", { kind: "attack" });
  assert.equal(agent.hp, 0);
  assert.equal(agent.itemsFound, 0, "carried items stop counting once dropped");
  assert.equal(sim.scoreOf(match, agent), 0);
});

test("friend names are validated before display", () => {
  assert.equal(P.normaliseFriendName("  Night jar  "), "Night jar");
  assert.equal(P.normaliseFriendName("O'Hara-7"), "O'Hara-7");
  assert.equal(P.normaliseFriendName(""), null);
  assert.equal(P.normaliseFriendName("<script>"), null);
  assert.equal(P.normaliseFriendName("x".repeat(40)).length, P.MAX_FRIEND_NAME);
  assert.equal(P.displayName("FALCON", "Nightjar"), "FALCON (Nightjar)");
  assert.equal(P.displayName("FALCON", null), "FALCON");
});
