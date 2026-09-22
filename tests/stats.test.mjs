import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.RF_DATA_DIR ??= "/tmp/claude-0/stats-test-data";

const { createStats } = await import("../server/stats.mjs");
const { handleStatsRequest, STATS_PATH, STATS_JSON_PATH } = await import("../server/stats-page.mjs");

const sampleRecap = seats => Array.from({ length: seats }, (_, i) => ({
  items: i === 0 ? 4 : 1, takedowns: 1, deaths: 1, hits: 2, damageDealt: 3, powerUps: 1,
}));

const serve = async report => {
  const server = createServer((request, response) => {
    if (handleStatsRequest(request, response, report)) return;
    response.writeHead(200, { "Content-Type": "text/plain" }).end("downstream");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.closeAllConnections(); server.close(); } };
};

const report = stats => () => ({
  live: { players: 2, lobbies: 1, openLobbies: 1, matches: 1 },
  careers: 3, top: [], rpc: { url: "https://rpc.example" }, protocol: 13,
  totals: stats.snapshot(),
});

test("a finished match moves every counter it should", () => {
  const stats = createStats();
  stats.matchStarted(3);
  stats.matchFinished({
    code: "AB12", seconds: 120, escaped: true, winner: "VIPER",
    reason: "escaped", recap: sampleRecap(3),
  });
  const totals = stats.snapshot();
  assert.equal(totals.matchesStarted, 1);
  assert.equal(totals.matchesFinished, 1);
  assert.equal(totals.seats, 3);
  assert.equal(totals.endings.escape, 1);
  assert.equal(totals.itemsRecovered, 4 + 1 + 1);
  assert.equal(totals.takedowns, 3);
  assert.equal(totals.deaths, 3);
  assert.equal(totals.averageMatchSeconds, 120);
  assert.equal(totals.averageSeats, 3);
  assert.equal(totals.recent[0].code, "AB12");
});

test("endings are classified by how the match actually ended", () => {
  const stats = createStats();
  const end = extra => stats.matchFinished({
    code: "ZZ99", seconds: 300, reason: "", recap: sampleRecap(2), ...extra,
  });
  end({ escaped: true, winner: "VIPER" });
  end({ escaped: false, winner: "KESTREL" });
  end({ escaped: false, winner: null });
  // Nobody left to recap: everybody disconnected.
  stats.matchFinished({ code: "ZZ99", seconds: 12, escaped: false, winner: null, recap: [] });
  const { endings } = stats.snapshot();
  assert.deepEqual(endings, { escape: 1, timeout: 1, stalemate: 1, abandoned: 1 });
});

test("peaks only ever rise", () => {
  const stats = createStats();
  stats.observe({ players: 7, matches: 2 });
  stats.observe({ players: 3, matches: 1 });
  const totals = stats.snapshot();
  assert.equal(totals.peakPlayers, 7, "a quiet moment must not lower the high-water mark");
  assert.equal(totals.peakMatches, 2);
});

test("daily buckets are kept per day and bounded", () => {
  const stats = createStats();
  const day = 86_400_000;
  for (let back = 45; back >= 0; back--) stats.matchStarted(2, Date.now() - back * day);
  const days = Object.keys(stats.snapshot().days);
  assert.ok(days.length <= 30, `kept ${days.length} days, expected the file to stay bounded`);
  assert.equal(days[days.length - 1], new Date().toISOString().slice(0, 10));
});

test("the recent list is newest first and bounded", () => {
  const stats = createStats();
  for (let index = 0; index < 40; index++) {
    stats.matchFinished({ code: `M${index}`, seconds: 60, escaped: true, winner: "A", recap: sampleRecap(2) });
  }
  const { recent } = stats.snapshot();
  assert.ok(recent.length <= 25, `kept ${recent.length} matches`);
  assert.equal(recent[0].code, "M39", "newest first");
});

test("the page serves HTML and the JSON twin serves JSON", async () => {
  const stats = createStats();
  stats.matchStarted(2);
  stats.matchFinished({ code: "QQ11", seconds: 90, escaped: true, winner: "HERON", recap: sampleRecap(2) });
  const { base, close } = await serve(report(stats));
  try {
    const page = await fetch(base + STATS_PATH);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("x-robots-tag"), /noindex/);
    const html = await page.text();
    assert.match(html, /THE RARE AGENCY/);
    assert.match(html, /QQ11/, "the finished match should be listed");
    assert.ok(!/src="http|href="https?:\/\//.test(html), "the page must load nothing from elsewhere");

    const json = await fetch(base + STATS_JSON_PATH);
    assert.match(json.headers.get("content-type"), /application\/json/);
    const body = await json.json();
    assert.equal(body.totals.matchesFinished, 1);
    assert.equal(body.live.players, 2);
  } finally { close(); }
});

test("everything else falls through to the game's own server", async () => {
  const { base, close } = await serve(report(createStats()));
  try {
    for (const path of ["/", "/index.html", "/game.html", "/statsomething"]) {
      const response = await fetch(base + path);
      assert.equal(await response.text(), "downstream", `${path} should not be taken by the dashboard`);
    }
  } finally { close(); }
});

test("the dashboard is read-only over HTTP", async () => {
  const { base, close } = await serve(report(createStats()));
  try {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(base + STATS_PATH, { method });
      assert.equal(response.status, 405, `${method} should be refused`);
    }
    assert.equal((await fetch(base + STATS_PATH, { method: "HEAD" })).status, 200);
  } finally { close(); }
});

test("a broken report is reported, not crashed on", async () => {
  const { base, close } = await serve(() => { throw new Error("relay is down"); });
  try {
    const response = await fetch(base + STATS_PATH);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /relay is down/);
  } finally { close(); }
});

test("player names and codenames are escaped, not injected", async () => {
  const stats = createStats();
  stats.matchFinished({
    code: "<script>alert(1)</script>", seconds: 10, escaped: true,
    winner: "<img src=x onerror=alert(1)>", recap: sampleRecap(1),
  });
  const { base, close } = await serve(report(stats));
  try {
    const html = await (await fetch(base + STATS_PATH)).text();
    assert.ok(!html.includes("<script>alert(1)</script>"), "a lobby code must not become markup");
    assert.ok(!html.includes("<img src=x"), "a codename must not become markup");
    assert.match(html, /&lt;script&gt;/, "it should appear escaped instead");
  } finally { close(); }
});
