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
import { project } from "../games/embassy-run/render.ts";

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
    await child.getByText("EMBASSY RUN", { exact: true }).waitFor({ timeout: 20000 });
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

  await shot(one.page, "1-briefing");

  await one.child.getByRole("button", { name: /^Buy crate/ }).click();
  await one.page.getByRole("button", { name: /^Confirm preview/ }).click();
  await one.child.getByText("One simulated Gadget Crate added.").waitFor();
  await one.child.getByRole("button", { name: "Open crate", exact: true }).click();
  await one.page.getByRole("button", { name: /^Confirm preview/ }).click();
  await one.child.getByRole("heading", { name: /Kit$/ }).waitFor({ timeout: 15000 });
  await shot(one.page, "2-crate-reveal");
  await one.child.getByRole("button", { name: /^Equip / }).click();

  await one.child.getByRole("button", { name: "Create", exact: true }).click();
  await one.child.getByRole("button", { name: "Create lobby", exact: true }).click();
  await one.child.locator(".er-code").waitFor();
  const code = (await one.child.locator(".er-code").innerText()).replace(/^CODE\s+/, "").split(" ")[0].trim();

  await two.child.getByRole("button", { name: "Code", exact: true }).click();
  await two.child.locator(".er-field input").fill(code);
  await two.child.getByRole("button", { name: "Join lobby", exact: true }).click();
  await two.child.locator(".er-roster li").nth(1).waitFor();
  await shot(one.page, "3-lobby");

  await one.child.getByRole("button", { name: "Ready", exact: true }).click();
  await two.child.getByRole("button", { name: "Ready", exact: true }).click();
  await one.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  await two.child.locator(".er-canvas").waitFor({ timeout: 20000 });
  // Give the canonical Friend artwork time to arrive before capturing.
  await one.page.waitForTimeout(4000);
  await shot(one.page, "4-match-desktop");
  await shot(two.page, "5-match-phone");

  // Walk agent one onto its nearest furniture and open the trap menu for a busier frame.
  const canvas = one.child.locator(".er-canvas");
  const box = await canvas.boundingBox();
  const [tx, ty] = project(Number(await canvas.getAttribute("data-near-x")), Number(await canvas.getAttribute("data-near-y")));
  await canvas.click({ position: { x: tx * box.width / 960, y: ty * box.height / 640 } });
  await one.page.waitForTimeout(1800);
  await one.child.getByRole("button", { name: /^Trap/ }).click().catch(() => {});
  await shot(one.page, "6-trap-menu");

  relay.stop();
} finally {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(`\nScreenshots in ${outDir}\n`);
