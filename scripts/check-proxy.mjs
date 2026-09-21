#!/usr/bin/env node
/**
 * Deployment topology check.
 *
 * In production a reverse proxy (Caddy, in docker-compose.yml) terminates TLS and forwards to
 * the app container. This check stands up that exact shape, a proxy on one port in front of
 * the game server on another, and drives a real browser through it: the sandboxed game frame
 * must still reach the relay, because FriendSDK's CSP permits only connect-src 'self'.
 *
 * Local development talks to the server directly and would never catch a regression here.
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { attachRelay, GAME_DIR, loadSdkRunner } from "./host.mjs";

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"))));
const fixture = await import(pathToFileURL(path.join(sdkRoot, "scripts/check-runtime-browser.mjs")).href);
const { FAMILIES_REGISTRY_ABI } = await import(pathToFileURL(path.join(sdkRoot, "dist/generation-sprites.js")).href);
const src = await readFile(path.join(sdkRoot, "examples/fishing/sample-sprites.ts"), "utf8");
const frames = [...src.split('"7730": decodeGenerationSprites')[1].split("]),")[0].matchAll(/0x[0-9a-f]+n/g)]
  .map(([w]) => BigInt(w.slice(0, -1)));
const artworkCall = call => {
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  const result = functionName === "familyOf" ? 5 : functionName === "seedOf" ? Number(args[0]) : frames;
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
};

const dir = await mkdtemp(path.join(tmpdir(), "proxytest-"));
let build, appServer, proxy, browser;
try {
  const { buildGame, createGameServer } = await loadSdkRunner();
  build = await buildGame(GAME_DIR, { outdir: path.join(dir, "dist"), watch: false });
  appServer = createGameServer(build.outdir);
  const relay = attachRelay(appServer, { log: () => {} });
  await new Promise(r => appServer.listen(0, "127.0.0.1", r));
  const appPort = appServer.address().port;
  console.log(`  app container listening on ${appPort}`);

  // Stand-in for Caddy: forward HTTP, and forward the upgrade handshake byte for byte.
  proxy = createServer((clientReq, clientRes) => {
    const upstream = httpRequest(
      { host: "127.0.0.1", port: appPort, path: clientReq.url, method: clientReq.method, headers: clientReq.headers },
      upstreamRes => {
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on("error", () => clientRes.writeHead(502).end());
    clientReq.pipe(upstream);
  });
  let upgradesProxied = 0;
  proxy.on("upgrade", (req, socket, head) => {
    upgradesProxied++;
    const upstream = connect(appPort, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
        "\r\n\r\n",
      );
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  console.log(`  proxy (stands in for Caddy) listening on ${proxy.address().port}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await fixture.installFixture(page, origin, { artworkCall });

  // Everything below goes through the proxy only; the app port is never addressed directly.
  await page.goto(origin);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
  const child = page.frameLocator("iframe");
  await child.getByText("THE RARE AGENCY", { exact: true }).waitFor({ timeout: 25000 });
  console.log("  game mounted through the proxy");

  await child.getByText(/Relay online/).waitFor({ timeout: 20000 });
  console.log("  RELAY ONLINE through the proxy");

  // Past the attract screen, which is what loads first.
  await child.getByRole("button", { name: "Enter the embassy", exact: true })
    .click({ timeout: 20000 });
  await child.getByRole("heading", { name: "Agent dossier" }).waitFor({ timeout: 15000 });

  // And a real lobby round-trip, to prove messages flow both ways.
  await child.getByRole("button", { name: "Create", exact: true }).click();
  await child.getByRole("button", { name: "Create lobby", exact: true }).click();
  await child.locator(".er-code").waitFor({ timeout: 15000 });
  const code = (await child.locator(".er-code").innerText()).replace(/^CODE\s+/, "").split(" ")[0].trim();
  assert.match(code, /^[A-Z0-9]{4}$/);
  console.log(`  lobby ${code} created and echoed back through the proxy`);

  assert.ok(upgradesProxied >= 1, "the proxy should have handled a WebSocket upgrade");
  console.log(`  websocket upgrades proxied: ${upgradesProxied}`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  relay.stop();
  console.log("\n  ✓ reverse-proxy topology works: the Caddy setup will serve this\n");
} finally {
  await browser?.close();
  proxy?.close();
  appServer?.closeAllConnections();
  appServer?.close();
  await build?.close();
  await rm(dir, { recursive: true, force: true });
}
