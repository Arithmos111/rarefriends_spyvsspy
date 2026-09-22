import test from "node:test";
import assert from "node:assert/strict";

const P = await import("../games/rare-agency/shared/protocol.ts");

const member = (ready, holdingUpSince = null) => ({ ready, holdingUpSince });
const clocksOf = (members, at) => P.stragglerClock(members, at);

test("a lobby nobody is ready in holds nobody up", () => {
  const members = [member(false), member(false), member(false)];
  assert.deepEqual(clocksOf(members, 1000), [null, null, null]);
});

test("a lobby everyone is ready in holds nobody up", () => {
  const members = [member(true), member(true)];
  assert.deepEqual(clocksOf(members, 1000), [null, null]);
});

test("a lobby too small to start holds nobody up", () => {
  const members = [member(true)];
  assert.deepEqual(clocksOf(members, 1000), [null]);
});

test("the one member holding a ready lobby up starts a clock", () => {
  const members = [member(true), member(true), member(false)];
  assert.deepEqual(clocksOf(members, 4200), [null, null, 4200]);
});

test("every unready member is clocked when some are ready", () => {
  const members = [member(true), member(false), member(false)];
  assert.deepEqual(clocksOf(members, 900), [null, 900, 900]);
});

test("a running clock keeps its original start, so the grace period does not restart", () => {
  const members = [member(true), member(false, 1000)];
  assert.deepEqual(clocksOf(members, 25_000), [null, 1000]);
});

test("readying up clears the clock", () => {
  const members = [member(true), member(true, 1000)];
  assert.deepEqual(clocksOf(members, 25_000), [null, null]);
});

test("the last ready member leaving clears everyone's clock", () => {
  const held = [member(true), member(false, 1000)];
  const after = [held[1]];
  after[0].holdingUpSince = clocksOf(held, 2000)[1];
  assert.deepEqual(clocksOf(after, 3000), [null], "a lobby of one is not waiting on anyone");
});

test("a straggler expires only once the grace period is up", () => {
  const started = 5000;
  assert.equal(P.stragglerExpired(started, started), false);
  assert.equal(P.stragglerExpired(started, started + P.LOBBY_READY_TIMEOUT_MS - 1), false);
  assert.equal(P.stragglerExpired(started, started + P.LOBBY_READY_TIMEOUT_MS), true);
  assert.equal(P.stragglerExpired(started, started + P.LOBBY_READY_TIMEOUT_MS * 2), true);
});

test("a member with no clock never expires", () => {
  assert.equal(P.stragglerExpired(null, 10_000_000), false);
});

test("the grace period is the thirty seconds the lobby advertises", () => {
  assert.equal(P.LOBBY_READY_TIMEOUT_MS, 30_000);
});
