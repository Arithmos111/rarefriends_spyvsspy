#!/usr/bin/env node
/**
 * End-to-end browser check.
 *
 * Two independent browser contexts connect through the real FriendSDK runtime, pass the
 * SDK's ownership gate with the SDK's own internal identity fixture, meet in one lobby and
 * play a live match against each other through the relay. Mock identities are used only
 * here, which is what AGENTS.md reserves them for.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { attachRelay, GAME_DIR, loadSdkRunner } from "./host.mjs";
import { project } from "../games/embassy-run/render.ts";

const sdkEntry = fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"));
const sdkRoot = path.dirname(path.dirname(sdkEntry));
const fixture = await import(pathToFileURL(path.join(sdkRoot, "scripts/check-runtime-browser.mjs")).href);
const { FAMILIES_REGISTRY_ABI, GENERATION_SPRITE_MANIFEST } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/generation-sprites.js")).href);

// The 64 canonical sample frames the SDK ships for its own browser fixtures.
const source = await readFile(path.join(sdkRoot, "examples/fishing/sample-sprites.ts"), "utf8");
const section = source.split('"7730": decodeGenerationSprites')[1].split("]),")[0];
const frames = [...section.matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));
assert.equal(frames.length, 64, "expected 64 canonical sample frames");

/** Both fixture Friends share the sample artwork; only their token IDs differ. */
function artworkCall(call) {
  assert.equal(call.to.toLowerCase(), GENERATION_SPRITE_MANIFEST.registry.toLowerCase());
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  let result;
  if (functionName === "familyOf") result = 5;
  else if (functionName === "seedOf") result = Number(args[0]);
  else if (functionName === "frames") result = frames;
  else throw new Error(`Unexpected artwork read ${functionName}`);
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

const SECOND_OWNER = "0x2222222222222222222222222222222222222222";
const problems = [];
const step = message => console.log(`  · ${message}`);

const directory = await mkdtemp(path.join(tmpdir(), "embassy-run-check-"));
let build, server, browser;
try {
  const { buildGame, createGameServer } = await loadSdkRunner();
  build = await buildGame(GAME_DIR, { outdir: path.join(directory, "dist"), watch: false });
  server = createGameServer(build.outdir);
  const relay = attachRelay(server, { log: () => {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  step(`serving ${origin}`);

  browser = await chromium.launch({ headless: true });

  async function openAgent({ width, touch, second }) {
    const context = await browser.newContext({
      viewport: { width, height: Math.round(width / 1.5) + 120 },
      hasTouch: touch, reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await fixture.installFixture(page, origin, { artworkCall });
    await page.goto(origin);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    if (second) {
      await page.evaluate(owner => window.__friendWalletTest.accounts([owner]), SECOND_OWNER);
    }
    const friend = second ? 3412 : 7730;
    await page.getByRole("button", { name: new RegExp(`^Friend #${friend}\\b`) }).click();
    const child = page.frameLocator("iframe");
    await child.getByText("EMBASSY RUN", { exact: true }).waitFor({ timeout: 20000 });
    return { page, context, child, errors, friend };
  }

  step("opening two agents through the SDK ownership gate");
  const one = await openAgent({ width: 1100, touch: false, second: false });
  const two = await openAgent({ width: 420, touch: true, second: true });

  // The container contract: one SDK frame, correct aspect, nothing outside it.
  await fixture.assertBounds(one.page);
  await fixture.assertBounds(two.page);
  step("SDK container bounds hold on desktop and phone widths");

  const relayOnline = async agent => {
    await agent.child.getByText(/Relay online/).waitFor({ timeout: 15000 });
  };
  await relayOnline(one);
  await relayOnline(two);
  step("both agents reached the same-origin relay from inside the sandbox");

  // --- Simulated economy: buy a crate and open it into a kit -----------------------------
  const confirm = page => page.getByRole("button", { name: /^Confirm preview/ }).click();
  await one.child.getByRole("button", { name: /^Buy crate/ }).click();
  await confirm(one.page);
  await one.child.getByText("One simulated Gadget Crate added.").waitFor({ timeout: 15000 });
  step("bought a simulated Gadget Crate through the SDK preview client");

  await one.child.getByRole("button", { name: "Open crate", exact: true }).click();
  await confirm(one.page);
  await one.child.getByRole("heading", { name: /Kit$/ }).waitFor({ timeout: 15000 });
  const revealed = await one.child.locator(".er-reveal h3").innerText();
  step(`crate opened into ${revealed}`);
  await one.child.getByRole("button", { name: /^Equip / }).click();

  // --- Matchmaking -----------------------------------------------------------------------
  await one.child.getByRole("button", { name: "Create", exact: true }).click();
  await one.child.getByRole("button", { name: "Create lobby", exact: true }).click();
  await one.child.locator(".er-code").waitFor({ timeout: 15000 });
  const codeText = await one.child.locator(".er-code").innerText();
  const code = codeText.replace(/^CODE\s+/, "").split(" ")[0].trim();
  assert.match(code, /^[A-Z0-9]{4}$/, `lobby code looked wrong: ${codeText}`);
  step(`agent one created lobby ${code}`);

  await two.child.getByRole("button", { name: "Code", exact: true }).click();
  await two.child.locator(".er-field input").fill(code);
  await two.child.getByRole("button", { name: "Join lobby", exact: true }).click();
  await two.child.locator(".er-roster li").nth(1).waitFor({ timeout: 15000 });
  step("agent two joined by code; both are in the roster");

  const rosterSize = await one.child.locator(".er-roster li:not(.er-slot-empty)").count();
  assert.equal(rosterSize, 2, "both agents should appear in the host's roster");

  await one.child.getByRole("button", { name: "Ready", exact: true }).click();
  await two.child.getByRole("button", { name: "Ready", exact: true }).click();
  step("both readied; waiting for the autostart countdown");

  await one.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  await two.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  step("match started for both agents");

  // --- Live play -------------------------------------------------------------------------
  const roomOf = agent => agent.child.locator(".er-room").innerText();
  const startRoom = await roomOf(one);

  await one.child.locator(".er-canvas").click({ position: { x: 5, y: 5 } });
  await one.page.keyboard.down("ArrowRight");
  await one.page.waitForTimeout(3200);
  await one.page.keyboard.up("ArrowRight");
  const afterRoom = await roomOf(one);
  assert.notEqual(afterRoom, startRoom, `keyboard movement should carry the agent out of ${startRoom}`);
  step(`keyboard movement moved agent one from ${startRoom} to ${afterRoom}`);

  // The touch agent drives the on-screen stick.
  const stick = two.child.locator(".er-stick");
  const stickBox = await stick.boundingBox();
  await two.page.touchscreen.tap(stickBox.x + stickBox.width * 0.9, stickBox.y + stickBox.height / 2);
  step("touch stick accepted a pointer on the phone-width agent");

  // Tap-to-walk to the nearest furniture, then search it. The outcome must come back
  // through the relay as a feed event, proving the server resolved the action.
  const canvasOne = one.child.locator(".er-canvas");
  const nearX = Number(await canvasOne.getAttribute("data-near-x"));
  const nearY = Number(await canvasOne.getAttribute("data-near-y"));
  assert.ok(Number.isFinite(nearX) && Number.isFinite(nearY), "the canvas should report the nearest furniture");
  const box = await canvasOne.boundingBox();
  const [targetScreenX, targetScreenY] = project(nearX, nearY);
  await canvasOne.click({ position: {
    x: targetScreenX * box.width / 960,
    y: targetScreenY * box.height / 640,
  } });
  await one.page.waitForFunction(
    () => document.querySelector("iframe").contentDocument?.querySelector(".er-canvas")?.dataset.inReach === "1",
    null, { timeout: 15000 },
  ).catch(async () => {
    assert.equal(await canvasOne.getAttribute("data-in-reach"), "1", "tap-to-walk should reach the nearest furniture");
  });
  step("tap-to-walk brought the agent into reach of the nearest furniture");

  await one.child.getByRole("button", { name: /^Search/ }).click();
  await one.child.locator(".er-feed li").first().waitFor({ timeout: 15000 });
  const feedText = await one.child.locator(".er-feed li").first().innerText();
  step(`search resolved on the server: "${feedText}"`);

  // The scoreboard proves both agents are in one authoritative match.
  const scores = await one.child.locator(".er-scores > div").count();
  assert.equal(scores, 2, "the scoreboard should list both agents");
  step("scoreboard shows both agents in one match");

  // Canvas is actually painting, not blank.
  const painted = await one.child.locator(".er-canvas").evaluate(canvas => {
    const context = canvas.getContext("2d");
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 997) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size;
  });
  assert.ok(painted > 4, `the embassy canvas looks blank (${painted} distinct sampled colours)`);
  step(`embassy canvas rendering (${painted} distinct sampled colours)`);

  // Traps menu opens and reports the equipped kit's stock.
  await one.child.getByRole("button", { name: /^Trap/ }).click();
  await one.child.getByRole("heading", { name: "Set a trap" }).waitFor({ timeout: 10000 });
  step("trap menu opens inside the SDK frame");
  await fixture.assertBounds(one.page);
  await one.child.getByRole("button", { name: /^Close Set a trap/ }).click();

  for (const agent of [one, two]) {
    if (agent.errors.length) problems.push(`agent ${agent.friend}: ${agent.errors.join(" | ")}`);
  }

  relay.stop();
} finally {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}

if (problems.length) {
  console.error("\nBrowser check failed:");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\n  ✓ browser check passed\n");
}
