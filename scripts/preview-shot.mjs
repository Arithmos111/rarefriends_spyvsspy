#!/usr/bin/env node
/**
 * Capture the submission's one screenshot.
 *
 * The entry leads on a single frame of a real match, so that frame has to earn it: two agents
 * in one room, the combat log full, the HUD showing the mission track and health, and the
 * action buttons naming their keys. Staging it by hand and cropping a lucky moment is how a
 * screenshot goes stale the next time the interface changes — so this drives two real browsers
 * through the same fixture the checks use, walks one agent across the embassy into the other,
 * has them fight, and captures the SDK frame exactly as a player sees it.
 *
 *   npm run preview           # writes docs/preview.png
 *   npm run preview -- <path>
 */
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChromium } from "./browser.mjs";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { attachRelay, GAME_DIR, loadSdkRunner } from "./host.mjs";
import { doorAnchorWorld, project } from "../games/rare-agency/render.ts";
import { DIRECTIONS } from "../games/rare-agency/shared/protocol.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(root, "docs/preview.png"));
await mkdir(path.dirname(out), { recursive: true });

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"))));
const fixture = await import(pathToFileURL(path.join(sdkRoot, "scripts/check-runtime-browser.mjs")).href);
const { FAMILIES_REGISTRY_ABI } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/generation-sprites.js")).href);
const source = await readFile(path.join(sdkRoot, "examples/fishing/sample-sprites.ts"), "utf8");
const frames = [...source.split('"7730": decodeGenerationSprites')[1].split("]),")[0]
  .matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));

function artworkCall(call) {
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  const result = functionName === "familyOf" ? 5 : functionName === "seedOf" ? Number(args[0]) : frames;
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

const directory = await mkdtemp(path.join(tmpdir(), "agency-preview-"));
let build, server, browser;
try {
  const { buildGame, createGameServer } = await loadSdkRunner();
  build = await buildGame(GAME_DIR, { outdir: path.join(directory, "dist"), watch: false });
  server = createGameServer(build.outdir);
  const relay = attachRelay(server, { log: () => {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchChromium({ headless: true });

  const open = async second => {
    // Wide enough that the SDK frame is at its full 960, and tall enough not to letterbox it.
    const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await fixture.installFixture(page, origin, { artworkCall });
    await page.goto(origin);
    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
    if (second) await page.evaluate(() => window.__friendWalletTest.accounts(["0x2222222222222222222222222222222222222222"]));
    await page.getByRole("button", { name: new RegExp(`^Friend #${second ? 3412 : 7730}\\b`) }).click();
    const child = page.frameLocator("iframe");
    await child.getByText("THE RARE AGENCY", { exact: true }).waitFor({ timeout: 20000 });
    await child.getByRole("button", { name: "Deploy this agent", exact: true }).click({ timeout: 25000 });
    await child.getByRole("button", { name: "Enter the embassy", exact: true }).click({ timeout: 25000 });
    await child.getByRole("heading", { name: "Agent dossier" }).waitFor({ timeout: 20000 });
    return { page, child };
  };

  const one = await open(false);
  const two = await open(true);

  // One lobby, both agents, straight into a match.
  await one.child.getByRole("button", { name: "Create", exact: true }).click();
  await one.child.getByRole("button", { name: "Create lobby", exact: true }).click();
  await one.child.locator(".er-code").waitFor();
  const code = (await one.child.locator(".er-code").innerText()).replace(/^CODE\s+/, "").split(" ")[0].trim();
  await two.child.getByRole("button", { name: "Code", exact: true }).click();
  await two.child.locator(".er-field input").fill(code);
  await two.child.getByRole("button", { name: "Join lobby", exact: true }).click();
  await two.child.locator(".er-roster li").nth(1).waitFor();
  await one.child.getByRole("button", { name: "Ready", exact: true }).click();
  await two.child.getByRole("button", { name: "Ready", exact: true }).click();
  for (const agent of [one, two]) await agent.child.locator(".er-canvas").waitFor({ timeout: 25000 });
  // The canonical artwork arrives over the mocked RPC; a shot without it is the point missed.
  await one.page.waitForTimeout(4000);

  const roomOf = agent => agent.child.locator(".er-room").innerText();

  const positionOf = async agent => {
    const canvas = agent.child.locator(".er-canvas");
    const [x, y] = await Promise.all([canvas.getAttribute("data-x"), canvas.getAttribute("data-y")]);
    return { x: Number(x), y: Number(y) };
  };

  /**
   * Walk an agent towards a point in its own room, on the keyboard, as a player would.
   *
   * Tap-to-walk is a straight line with no pathfinding — the game gives the destination up
   * rather than grind into the side of a cabinet — so it cannot be used to cross a room
   * reliably. This holds the arrow keys towards the target in short bursts and re-reads the
   * position the canvas publishes, sidestepping when a burst achieved nothing.
   */
  const steer = async (agent, toX, toY, bursts = 26) => {
    let last = await positionOf(agent);
    for (let burst = 0; burst < bursts; burst++) {
      const at = await positionOf(agent);
      const dx = toX - at.x, dy = toY - at.y;
      if (Math.hypot(dx, dy) < 18) return true;
      const keys = [];
      if (Math.abs(dx) > 12) keys.push(dx > 0 ? "ArrowRight" : "ArrowLeft");
      if (Math.abs(dy) > 12) keys.push(dy > 0 ? "ArrowDown" : "ArrowUp");
      // Nothing moved last time, so something is in the way: slide along the other axis.
      if (Math.hypot(at.x - last.x, at.y - last.y) < 3 && burst > 0) {
        keys.push(Math.abs(dx) > Math.abs(dy) ? "ArrowUp" : "ArrowRight");
      }
      last = at;
      for (const key of keys) await agent.page.keyboard.down(key);
      await agent.page.waitForTimeout(190);
      for (const key of keys) await agent.page.keyboard.up(key);
      await agent.page.waitForTimeout(40);
    }
    return false;
  };

  // Agents spawn in different corners of the 3x3 block. Aim for each threshold in turn and
  // keep whichever one changed the room: nine rooms, so this finds the other agent quickly,
  // and it needs no map knowledge in this script.
  const target = await roomOf(two);
  let met = (await roomOf(one)) === target;
  // Random rather than round-robin: cycling the four directions in order walks east, back
  // west, east again, and never leaves the pair of rooms it started between.
  for (let hop = 0; hop < 40 && !met; hop++) {
    const direction = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
    const anchor = doorAnchorWorld(direction);
    const room = await roomOf(one);
    // Line up on the doorway's centre first, then push through it.
    await steer(one, anchor.x, anchor.y, 14);
    for (let push = 0; push < 6 && (await roomOf(one)) === room; push++) {
      const key = { north: "ArrowUp", south: "ArrowDown", west: "ArrowLeft", east: "ArrowRight" }[direction];
      await one.page.keyboard.down(key);
      await one.page.waitForTimeout(180);
      await one.page.keyboard.up(key);
    }
    met = (await roomOf(one)) === target;
    if (process.env.PREVIEW_DEBUG) console.log(`  hop ${hop} ${direction} -> "${await roomOf(one)}"`);
  }
  if (!met) console.warn("  (the agents never met; capturing the room as it stands)");

  // Close on the other agent and trade blows, so the log has something in it, the health bars
  // are not pristine, and the strike is caught mid-fight rather than idle.
  // Four exchanges, not a takedown: a downed agent is off the screen while it respawns, and
  // the whole point of the shot is two Friends in one room. This leaves both standing, both
  // marked, and the log full.
  if (met) {
    for (let exchange = 0; exchange < 3; exchange++) {
      // Stop beside the rival, not on top of them: walking onto the same spot stacks the two
      // sprites and their name plates, and the shot is meant to show two Friends.
      const spot = await positionOf(two);
      // Just inside striking range (46), so the blows land, but far enough apart that the
      // two sprites and their name plates do not stack.
      const side = spot.x > 260 ? -1 : 1;
      await steer(one, spot.x + side * 40, spot.y + 10, 10);
      await one.page.keyboard.press("Space");
      await one.page.waitForTimeout(340);
      await two.page.keyboard.press("Space");
      await two.page.waitForTimeout(340);
    }
  }

  // Capture the SDK frame itself, not the page around it: that is the game as it is embedded.
  await two.page.waitForTimeout(900);
  const frame = one.page.locator(".rf-game-frame");
  await frame.screenshot({ path: out, scale: "css" });
  const log = await one.child.locator(".er-feed li").allInnerTexts();
  console.log(`Wrote ${path.relative(root, out)}`);
  console.log(log.length ? `Combat log in frame:\n${log.map(line => `  ${line}`).join("\n")}` : "  (empty log)");

  relay.stop();
} finally {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await build?.close();
  await rm(directory, { recursive: true, force: true });
}
