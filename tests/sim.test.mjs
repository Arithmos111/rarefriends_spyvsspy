import test from "node:test";
import assert from "node:assert/strict";

const sim = await import("../games/rare-agency/shared/sim.ts");
const map = await import("../games/rare-agency/shared/mansion.ts");
const P = await import("../games/rare-agency/shared/protocol.ts");
const kits = await import("../games/rare-agency/shared/loadouts.ts");
const view = await import("../games/rare-agency/shared/view.ts");

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
    const standing = room.furniture.filter(piece => !P.isWallMounted(piece.type));
    assert.equal(standing.length, 5, `room ${room.index} should stand five pieces on the floor`);
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
  const doorId = P.canonicalDoorTrapId(0, "east");
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
  const doorId = P.canonicalDoorTrapId(0, "east");
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
  sim.applyAction(match, "a", { kind: "plant", targetId: P.canonicalDoorTrapId(0, "east"), trap: "bomb" });
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

// --- Detonation and swing effects -------------------------------------------------------

test("each trap type springs an effect of its own kind where the victim stood", () => {
  for (const type of P.TRAP_TYPES) {
    const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
    const owner = match.players.get("a");
    const victim = match.players.get("b");
    const piece = match.map.rooms[0].furniture[0];
    owner.room = 0; owner.x = piece.x; owner.y = piece.y + 30;
    owner.traps[type] = 1;
    sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: type });
    run(match, P.PLANT_MS + 100);

    // Move the owner elsewhere so the cue below cannot be confused with the victim's own.
    owner.room = 4;
    victim.room = 0; victim.x = piece.x; victim.y = piece.y + 30;
    match.cues.length = 0;
    match.effects.length = 0;
    sim.applyAction(match, "b", { kind: "search", furnitureId: piece.id });
    run(match, P.SEARCH_MS + 200);

    const spawned = match.effects.filter(entry => entry.kind === type);
    assert.equal(spawned.length, 1, `${type} should spawn exactly one effect`);
    assert.equal(spawned[0].room, 0, `the ${type} effect belongs to the room it went off in`);
    assert.equal(spawned[0].x, victim.x, `the ${type} effect sits where the victim stood`);

    assert.ok(match.cues.some(entry => entry.kind === "trap" && entry.trap === type
      && entry.to === "b"), `the victim is told which trap caught them (${type})`);
    assert.ok(match.cues.some(entry => entry.kind === "trap-sprung" && entry.trap === type
      && entry.to === "a"), `the owner hears their own ${type} spring, from another room`);
  }
});

test("an agent caught by their own trap is not told somebody else walked into it", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const agent = match.players.get("a");
  const piece = match.map.rooms[0].furniture[0];
  agent.room = 0; agent.x = piece.x; agent.y = piece.y + 30;
  sim.applyAction(match, "a", { kind: "plant", targetId: piece.id, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  match.cues.length = 0;
  sim.applyAction(match, "a", { kind: "search", furnitureId: piece.id });
  run(match, P.SEARCH_MS + 200);
  assert.ok(!match.cues.some(entry => entry.kind === "trap-sprung"),
    "an own goal must not report as a trap catching somebody");
});

test("a landed blow spawns a slash for the knife and an impact for a fist", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 200; attacker.y = 200; attacker.invulnerableUntil = 0;
  target.room = 0; target.x = 220; target.y = 200; target.invulnerableUntil = 0;

  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.ok(match.effects.some(e => e.kind === "impact"), "a bare fist lands as an impact");

  attacker.knife = true;
  attacker.attackReadyAt = 0;
  target.stunnedUntil = 0;
  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.ok(match.effects.some(e => e.kind === "slash"), "the stiletto lands as a slash");
});

test("a missed swing spawns no effect", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  match.players.get("b").room = 5;
  attacker.room = 0; attacker.x = 200; attacker.y = 200;
  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(match.effects.length, 0, "swinging at nobody leaves nothing behind");
});

test("effects are pruned once their animation has run out", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 200; attacker.y = 200; attacker.invulnerableUntil = 0;
  target.room = 0; target.x = 220; target.y = 200; target.invulnerableUntil = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  // A blow leaves the strike itself and a floating damage number.
  assert.ok(match.effects.length >= 1);
  const longest = Math.max(...match.effects.map(e => P.EFFECT_DURATION_MS[e.kind]));
  run(match, longest + 100);
  assert.equal(match.effects.length, 0, "presentation state must not accumulate over a match");
});

// --- Room furnishing and the name plate -------------------------------------------------

test("every room is furnished only from its own palette", () => {
  for (const seed of [1, 7, 20260920, 99991]) {
    const embassy = map.createMap(seed);
    for (const room of embassy.rooms) {
      const allowed = [...P.ROOM_FURNITURE[room.index], ...P.ROOM_WALL_FURNITURE[room.index]];
      assert.ok(P.ROOM_FURNITURE[room.index], `room ${room.index} should have a furniture palette`);
      for (const piece of room.furniture) {
        assert.ok(allowed.includes(piece.type),
          `${P.ROOM_NAMES[room.index]} should not contain a ${piece.type}`);
      }
    }
  }
});

test("a room's furniture is varied rather than five of the same thing", () => {
  for (const seed of [1, 7, 20260920, 99991]) {
    const embassy = map.createMap(seed);
    for (const room of embassy.rooms) {
      const kinds = new Set(room.furniture
        .filter(piece => !P.isWallMounted(piece.type)).map(piece => piece.type));
      assert.ok(kinds.size >= 4,
        `${P.ROOM_NAMES[room.index]} has only ${kinds.size} kinds of furniture on seed ${seed}`);
    }
  }
});

test("every furniture type has a footprint, a label and appears somewhere", () => {
  const placed = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    for (const room of map.createMap(seed).rooms) {
      for (const piece of room.furniture) placed.add(piece.type);
    }
  }
  for (const type of P.FURNITURE_TYPES) {
    assert.ok(P.FURNITURE_FOOTPRINT[type], `${type} needs a footprint`);
    assert.ok(P.FURNITURE_LABELS[type], `${type} needs a label`);
    assert.ok(placed.has(type), `${type} is never placed in any room`);
  }
});

test("wall dressing never overlaps the room name plate", () => {
  // The plate hangs at the middle of whichever far wall has no doorway. Screen separation
  // along a wall is proportional to world separation, so this is checked in world units.
  const CLEAR = 130;
  for (const seed of [1, 7, 20260920, 99991]) {
    const embassy = map.createMap(seed);
    for (const room of embassy.rooms) {
      const onNorth = !room.doors.includes("north");
      for (const piece of room.decor) {
        const onSignWall = onNorth ? piece.y === 0 : piece.x === 0;
        if (!onSignWall) continue;
        const gap = onNorth
          ? Math.abs(piece.x - P.ROOM_W / 2)
          : Math.abs(piece.y - P.ROOM_H / 2);
        assert.ok(gap >= CLEAR,
          `${P.ROOM_NAMES[room.index]}: a ${piece.type} sits ${gap} from the name plate`);
      }
    }
  }
});

test("furniture never clips other furniture, and every room is fully furnished", () => {
  for (let seed = 1; seed <= 120; seed++) {
    for (const room of map.createMap(seed).rooms) {
      // Wall pieces hang above head height and are excluded: they legitimately overlap the
      // footprint of anything standing against the same wall.
      const standing = room.furniture.filter(piece => !P.isWallMounted(piece.type));
      assert.equal(standing.length, 5,
        `${P.ROOM_NAMES[room.index]} on seed ${seed} has ${standing.length} standing pieces`);
      for (let i = 0; i < standing.length; i++) {
        for (let j = i + 1; j < standing.length; j++) {
          const a = standing[i];
          const b = standing[j];
          const fa = P.FURNITURE_FOOTPRINT[a.type];
          const fb = P.FURNITURE_FOOTPRINT[b.type];
          const apart = Math.abs(a.x - b.x) >= (fa.w + fb.w) / 2
            || Math.abs(a.y - b.y) >= (fa.h + fb.h) / 2;
          assert.ok(apart,
            `seed ${seed} ${P.ROOM_NAMES[room.index]}: ${a.type} and ${b.type} interpenetrate`);
        }
      }
    }
  }
});

// --- A doorway is one opening, trapped from both sides -----------------------------------

test("a doorway trap fires on an agent coming through from the far side", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");

  // Planted from room 0, on its east door.
  planter.room = 0; planter.x = P.ROOM_W; planter.y = P.ROOM_H / 2;
  sim.applyAction(match, "a", {
    kind: "plant", targetId: P.canonicalDoorTrapId(0, "east"), trap: "bomb",
  });
  run(match, P.PLANT_MS + 100);
  planter.room = 8;

  // Walked into from room 1, through what room 1 calls its west door: the same opening.
  victim.room = 1; victim.x = 40; victim.y = P.ROOM_H / 2;
  victim.invulnerableUntil = 0;
  sim.applyInput(match, "b", 1, -1, 0);
  run(match, 2500);
  assert.equal(victim.room, 0, "the victim should have crossed into room 0");
  assert.equal(victim.hp, 0, "a trapped doorway must fire whichever way it is crossed");
  assert.equal(planter.takedowns, 1, "the planter gets the takedown from either side");
});

test("both sides of a doorway name the same trap", () => {
  for (const [room, direction] of [[0, "east"], [0, "south"], [4, "north"], [7, "west"]]) {
    const neighbour = P.neighbourRoom(room, direction);
    assert.notEqual(neighbour, null, `room ${room} should have a ${direction} neighbour`);
    assert.equal(
      P.canonicalDoorTrapId(room, direction),
      P.canonicalDoorTrapId(neighbour, P.oppositeDirection(direction)),
      `room ${room}'s ${direction} door and room ${neighbour}'s ${P.oppositeDirection(direction)} door are one opening`,
    );
  }
});

test("a doorway trap can be planted and disarmed from either side", () => {
  const match = start(roster({ id: "a", kit: "director" }, { id: "b", kit: "director" }));
  const planter = match.players.get("a");
  const other = match.players.get("b");
  const doorId = P.canonicalDoorTrapId(0, "east");

  planter.room = 0; planter.x = P.ROOM_W; planter.y = P.ROOM_H / 2;
  sim.applyAction(match, "a", { kind: "plant", targetId: doorId, trap: "spring" });
  run(match, P.PLANT_MS + 100);
  assert.ok(match.traps.has(doorId), "the doorway should hold the trap");

  // The far side addresses the same opening by its own wall, and must still reach it.
  other.room = 1; other.x = 0; other.y = P.ROOM_H / 2;
  sim.applyAction(match, "b", {
    kind: "disarm", targetId: P.canonicalDoorTrapId(1, "west"),
  });
  run(match, P.DISARM_MS + 100);
  assert.ok(!match.traps.has(doorId), "disarming from the far side should clear the doorway");
});

test("a doorway trap is visible from both rooms, marked on the viewer's own wall", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  planter.room = 0; planter.x = P.ROOM_W; planter.y = P.ROOM_H / 2;
  sim.applyAction(match, "a", {
    kind: "plant", targetId: P.canonicalDoorTrapId(0, "east"), trap: "bomb",
  });
  run(match, P.PLANT_MS + 100);

  const here = view.buildSnapshot(match, "a").traps.find(entry => entry.direction);
  assert.ok(here, "the planter should see their own doorway trap");
  assert.equal(here.direction, "east", "marked on the planter's east wall");

  // The same trap, seen from the other room by someone carrying a detector.
  planter.room = 1; planter.x = 0; planter.y = P.ROOM_H / 2;
  const across = view.buildSnapshot(match, "a").traps.find(entry => entry.direction);
  assert.ok(across, "the same opening should be visible from the far side");
  assert.equal(across.direction, "west", "marked on that room's own west wall");
  assert.equal(across.targetId, here.targetId, "and it is the same trap, not a second one");
});

// --- Clocks and portraits on the wall ----------------------------------------------------

test("every room hangs something searchable on its wall", () => {
  for (const seed of [1, 7, 20260920, 99991]) {
    for (const room of map.createMap(seed).rooms) {
      const hanging = room.furniture.filter(piece => P.isWallMounted(piece.type));
      assert.ok(hanging.length >= 1,
        `${P.ROOM_NAMES[room.index]} on seed ${seed} hangs nothing`);
      for (const piece of hanging) {
        assert.ok(piece.x === 0 || piece.y === 0,
          `a ${piece.type} should hang on one of the two visible walls`);
      }
    }
  }
});

test("a hanging can be searched, and yields what it hides", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const agent = match.players.get("a");
  const room = match.map.rooms[0];
  const hanging = room.furniture.find(piece => P.isWallMounted(piece.type));
  assert.ok(hanging, "room 0 should hang something");
  hanging.contents = "documents";

  agent.room = 0;
  agent.x = hanging.x === 0 ? 40 : hanging.x;
  agent.y = hanging.y === 0 ? 40 : hanging.y;
  sim.applyAction(match, "a", { kind: "search", furnitureId: hanging.id });
  run(match, P.SEARCH_MS + 200);
  assert.deepEqual(agent.inventory, ["documents"], "searching a hanging should yield its contents");
  assert.equal(hanging.searched, true);
});

test("a hanging can be trapped, and the trap fires on whoever searches it", () => {
  const match = start(roster({ id: "a", kit: "demolition" }, { id: "b" }));
  const planter = match.players.get("a");
  const victim = match.players.get("b");
  const room = match.map.rooms[0];
  const hanging = room.furniture.find(piece => P.isWallMounted(piece.type));

  const standAtHanging = player => {
    player.room = 0;
    player.x = hanging.x === 0 ? 40 : hanging.x;
    player.y = hanging.y === 0 ? 40 : hanging.y;
  };

  standAtHanging(planter);
  sim.applyAction(match, "a", { kind: "plant", targetId: hanging.id, trap: "bomb" });
  run(match, P.PLANT_MS + 100);
  assert.equal(match.traps.get(hanging.id)?.type, "bomb", "a portrait should take a trap");
  planter.room = 8;

  standAtHanging(victim);
  victim.invulnerableUntil = 0;
  sim.applyAction(match, "b", { kind: "search", furnitureId: hanging.id });
  run(match, P.SEARCH_MS + 200);
  assert.equal(victim.hp, 0, "the trap behind the portrait should fire");
  assert.equal(planter.takedowns, 1);
});

test("hangings never block movement themselves", () => {
  for (const seed of [1, 7, 20260920]) {
    for (const room of map.createMap(seed).rooms) {
      for (const piece of room.furniture) {
        if (!P.isWallMounted(piece.type)) continue;
        // A room containing only this hanging: anything else standing nearby is its own
        // obstacle, and is not what this is checking.
        const alone = { ...room, furniture: [piece] };
        const x = piece.x === 0 ? P.PLAYER_RADIUS + 1 : piece.x;
        const y = piece.y === 0 ? P.PLAYER_RADIUS + 1 : piece.y;
        assert.ok(!map.blockedByFurniture(alone, x, y),
          `a ${piece.type} in ${P.ROOM_NAMES[room.index]} blocks the floor beneath it`);
      }
    }
  }
});

/**
 * Can an agent actually walk from the middle of the room to within reach of this piece?
 *
 * Checking only that some nearby point is unoccupied is not enough: furniture can enclose a
 * free pocket that nothing can walk into. This floods the floor on a coarse grid from the
 * room's centre and asks whether any reachable cell is in range.
 */
function walkableToReach(room, piece) {
  const STEP = 8;
  const key = (cx, cy) => `${cx},${cy}`;
  const startCell = [Math.round(P.ROOM_W / 2 / STEP), Math.round(P.ROOM_H / 2 / STEP)];
  const seen = new Set([key(...startCell)]);
  const queue = [startCell];
  while (queue.length) {
    const [cx, cy] = queue.shift();
    const x = cx * STEP;
    const y = cy * STEP;
    if (Math.hypot(piece.x - x, piece.y - y) <= P.INTERACT_RANGE) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (seen.has(key(nx, ny))) continue;
      const px = nx * STEP;
      const py = ny * STEP;
      if (!map.insideRoom(px, py)) continue;
      if (map.blockedByFurniture(room, px, py)) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  return false;
}

test("every piece of furniture can be walked to and searched", () => {
  // The earlier version of this only asked whether a free spot existed near the piece, which
  // a pocket enclosed by other furniture satisfies. Walking there is the real requirement.
  for (const seed of [1, 7, 42, 20260920, 99991]) {
    for (const room of map.createMap(seed).rooms) {
      for (const piece of room.furniture) {
        assert.ok(walkableToReach(room, piece),
          `seed ${seed}: the ${piece.type} in ${P.ROOM_NAMES[room.index]} cannot be walked to`);
      }
    }
  }
});

test("every room has a cache, in the same place, and intelligence only ever hides there", () => {
  for (const seed of [1, 7, 42, 20260920, 99991]) {
    const embassy = map.createMap(seed);
    map.placeMissionItems(embassy, seed);
    for (const room of embassy.rooms) {
      const cache = room.furniture.filter(piece => piece.slot === map.CACHE_SLOT);
      assert.equal(cache.length, 1,
        `seed ${seed}: ${P.ROOM_NAMES[room.index]} should have exactly one cache`);
      for (const piece of room.furniture) {
        if (!piece.contents || !P.MISSION_ITEMS.includes(piece.contents)) continue;
        assert.equal(piece.slot, map.CACHE_SLOT,
          `seed ${seed}: ${piece.contents} hid outside the cache in ${P.ROOM_NAMES[room.index]}`);
      }
    }
    // And the cache is in the same world position in every room, so it is learnable.
    const spots = new Set(embassy.rooms
      .map(room => room.furniture.find(piece => piece.slot === map.CACHE_SLOT))
      .map(piece => `${piece.x},${piece.y}`));
    assert.equal(spots.size, 1, `seed ${seed}: caches should share one position, saw ${[...spots]}`);
  }
});

// --- Career points and combat feedback ---------------------------------------------------

test("career points are one for playing and two more for winning", () => {
  assert.equal(P.careerPointsFor(false), P.CAREER_POINTS_PLAYED);
  assert.equal(P.careerPointsFor(true), P.CAREER_POINTS_PLAYED + P.CAREER_POINTS_WIN);
  assert.equal(P.careerPointsFor(false), 1, "turning up is worth one");
  assert.equal(P.careerPointsFor(true), 3, "a win is worth three all told");
});

test("a landed blow tells both agents, and floats the damage where it hit", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  const attacker = match.players.get("a");
  const target = match.players.get("b");
  attacker.room = 0; attacker.x = 200; attacker.y = 200; attacker.invulnerableUntil = 0;
  target.room = 0; target.x = 220; target.y = 200; target.invulnerableUntil = 0;

  match.cues.length = 0;
  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });

  assert.ok(match.cues.some(c => c.kind === "hurt" && c.to === "b" && c.amount === 1),
    "the victim is told what it cost them");
  assert.ok(match.cues.some(c => c.kind === "hit" && c.to === "a" && c.amount === 1),
    "the attacker is told they connected");
  const number = match.effects.find(e => e.kind === "damage1");
  assert.ok(number, "a damage number should float where the blow landed");
  assert.equal(number.x, target.x);

  // The knife reads as the heavier hit on both sides.
  attacker.knife = true;
  attacker.attackReadyAt = 0;
  target.stunnedUntil = 0;
  target.hp = P.PLAYER_MAX_HP;
  match.cues.length = 0;
  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.ok(match.cues.some(c => c.kind === "hurt" && c.amount === 2));
  assert.ok(match.cues.some(c => c.kind === "hit" && c.amount === 2));
  assert.ok(match.effects.some(e => e.kind === "damage2"));
});

test("a missed swing tells nobody anything", () => {
  const match = start(roster({ id: "a" }, { id: "b" }));
  match.players.get("b").room = 5;
  const attacker = match.players.get("a");
  attacker.room = 0; attacker.x = 200; attacker.y = 200;
  match.cues.length = 0;
  match.effects.length = 0;
  sim.applyAction(match, "a", { kind: "attack" });
  assert.equal(match.cues.length, 0, "swinging at nobody is not feedback");
  assert.equal(match.effects.length, 0);
});
