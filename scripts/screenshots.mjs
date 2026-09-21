#!/usr/bin/env node
/** Capture reference screenshots of each screen. Uses the same mocked-identity fixture as the browser check. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { attachRelay, GAME_DIR, loadSdkRunner } from "./host.mjs";
import { project } from "../games/rare-agency/render.ts";

const outDir = process.argv[2] ?? path.join(fileURLToPath(new URL("..", import.meta.url)), ".build/shots");
await mkdir(outDir, { recursive: true });

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"))));
const fixture = await import(pathToFileURL(path.join(sdkRoot, "scripts/check-runtime-browser.mjs")).href);
const { FAMILIES_REGISTRY_ABI, GENERATION_SPRITE_MANIFEST } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/generation-sprites.js")).href);
const source = await readFile(path.join(sdkRoot, "examples/fishing/sample-sprites.ts"), "utf8");
const frames = [...source.split('"7730": decodeGenerationSprites')[1].split("]),")[0]
  .matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));

function artworkCall(call) {
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  const result = functionName === "familyOf" ? 5 : functionName === "seedOf" ? Number(args[0]) : frames;
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

const directory = await mkdtemp(path.join(tmpdir(), "embassy-shots-"));
let build, server, browser;
try {
  const { buildGame, createGameServer } = await loadSdkRunner();
  build = await buildGame(GAME_DIR, { outdir: path.join(directory, "dist"), watch: false });
  server = createGameServer(build.outdir);
  const relay = attachRelay(server, { log: () => {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });

  const open = async ({ width, height, second, touch }) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await fixture.installFixture(page, origin, { artworkCall });
    await page.goto(origin);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    if (second) await page.evaluate(() => window.__friendWalletTest.accounts(["0x2222222222222222222222222222222222222222"]));
    await page.getByRole("button", { name: new RegExp(`^Friend #${second ? 3412 : 7730}\\b`) }).click();
    const child = page.frameLocator("iframe");
    await child.getByText("THE RARE AGENCY", { exact: true }).waitFor({ timeout: 20000 });
    await child.getByText(/Relay online/).waitFor({ timeout: 15000 });
    return { page, child };
  };

  const shot = async (page, name) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`  · ${name}.png`);
  };

  const one = await open({ width: 1180, height: 860, second: false, touch: false });
  const two = await open({ width: 430, height: 880, second: true, touch: true });

  // The agent confirmation, the attract screen, the training run, then the briefing.
  await one.child.getByRole("button", { name: "Deploy this agent", exact: true })
    .waitFor({ timeout: 25000 });
  await shot(one.page, "0-confirm-agent");
  for (const agent of [one, two]) {
    await agent.child.getByRole("button", { name: "Deploy this agent", exact: true })
      .click({ timeout: 25000 }).catch(() => {});
  }
  await one.child.getByRole("button", { name: "Training run", exact: true })
    .waitFor({ timeout: 25000 });
  await shot(one.page, "1-title");

  await one.child.getByRole("button", { name: "Training run", exact: true }).click();
  await one.child.locator(".er-lesson").waitFor({ timeout: 15000 });
  await shot(one.page, "2-training");
  // Collapsed, so the room underneath is clear to experiment in.
  await one.child.getByRole("button", { name: /^Got it/ }).click();
  await one.child.locator(".er-lesson-bar").waitFor({ timeout: 10000 });
  await shot(one.page, "2b-training-hidden");
  await one.child.getByRole("button", { name: "Show", exact: true }).click();
  await one.child.locator(".er-lesson").waitFor({ timeout: 10000 });
  // Step on a few lessons so the shot shows a staged one rather than "walk about".
  for (let index = 0; index < 4; index++) {
    await one.child.getByRole("button", { name: "Next step", exact: true }).click();
    await one.page.waitForTimeout(160);
  }
  if (await one.child.locator(".er-lesson").count()) await shot(one.page, "3-training-trap");
  await one.child.getByRole("button", { name: "Leave training", exact: true }).click();

  const enter = one.child.getByRole("button", { name: "Enter the embassy", exact: true });
  if (await enter.count()) await enter.click();
  await one.child.getByRole("heading", { name: "Agent dossier" }).waitFor({ timeout: 15000 });
  for (const agent of [two]) {
    const gate = agent.child.getByRole("button", { name: "Enter the embassy", exact: true });
    await gate.click({ timeout: 25000 }).catch(() => {});
  }
  await shot(one.page, "4-briefing");

  await one.child.getByRole("button", { name: /^Buy crate/ }).click();
  await one.page.getByRole("button", { name: /^Confirm preview/ }).click();
  await one.child.getByText("One simulated Gadget Crate added.").waitFor();
  await one.child.getByRole("button", { name: "Open crate", exact: true }).click();
  await one.page.getByRole("button", { name: /^Confirm preview/ }).click();
  await one.child.getByRole("heading", { name: /Kit$/ }).waitFor({ timeout: 15000 });
  await shot(one.page, "5-crate-reveal");
  await one.child.getByRole("button", { name: /^Equip / }).click();

  await one.child.getByRole("button", { name: "Create", exact: true }).click();
  await one.child.getByRole("button", { name: "Create lobby", exact: true }).click();
  await one.child.locator(".er-code").waitFor();
  const code = (await one.child.locator(".er-code").innerText()).replace(/^CODE\s+/, "").split(" ")[0].trim();

  await two.child.getByRole("button", { name: "Code", exact: true }).click();
  await two.child.locator(".er-field input").fill(code);
  await two.child.getByRole("button", { name: "Join lobby", exact: true }).click();
  await two.child.locator(".er-roster li").nth(1).waitFor();
  await shot(one.page, "6-lobby");

  await one.child.getByRole("button", { name: "Ready", exact: true }).click();
  await two.child.getByRole("button", { name: "Ready", exact: true }).click();
  await one.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  await two.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  // Give the canonical Friend artwork time to arrive before capturing.
  await one.page.waitForTimeout(4000);
  await shot(one.page, "7-match-desktop");
  await shot(two.page, "8-match-phone");

  // Walk agent one onto its nearest furniture and open the trap menu for a busier frame.
  const canvas = one.child.locator(".er-canvas");
  const box = await canvas.boundingBox();
  const scale = Math.min(box.width / 960, box.height / 640);
  const [tx, ty] = project(Number(await canvas.getAttribute("data-near-x")), Number(await canvas.getAttribute("data-near-y")));
  await canvas.click({ position: {
    x: tx * scale + (box.width - 960 * scale) / 2,
    y: ty * scale + (box.height - 640 * scale) / 2,
  } });
  await one.page.waitForTimeout(1800);
  await one.child.getByRole("button", { name: /^Trap/ }).click().catch(() => {});
  await shot(one.page, "9-trap-menu");
  await one.child.getByRole("button", { name: /^Close Set a trap/ }).click().catch(() => {});

  // A few searches for a pickup flash. Loot placement is seeded, so this is opportunistic
  // rather than guaranteed; the run continues either way.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await one.child.locator(".er-flash").count()) break;
    await one.child.getByRole("button", { name: /^Search/ }).click().catch(() => {});
    await one.page.waitForTimeout(900);
  }
  if (await one.child.locator(".er-flash").count()) await shot(one.page, "10-pickup-flash");
  else console.log("  (no pickup flash this run)");

  // The career standings and the Friend naming screen, both from the briefing room.
  await one.child.getByRole("button", { name: "Leave", exact: true }).click().catch(() => {});
  await one.page.waitForTimeout(800);
  await one.child.getByRole("button", { name: /^Standings/ }).click().catch(() => {});
  await shot(one.page, "11-standings");
  await one.child.getByRole("button", { name: /^Close Career standings/ }).click().catch(() => {});
  await one.child.getByRole("button", { name: /^Name Friend|^Rename/ }).click().catch(() => {});
  await one.child.locator(".er-field input").fill("Nightjar").catch(() => {});
  await shot(one.page, "12-name-friend");

  relay.stop();
} finally {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(`\nScreenshots in ${outDir}\n`);
