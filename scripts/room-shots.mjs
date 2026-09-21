#!/usr/bin/env node
/**
 * Renders one picture of every room in the mansion, into .build/rooms.
 *
 * A development tool. It bundles tools/room-gallery.ts, which drives the game's own renderer
 * against a real simulation, so the gallery cannot drift from what players actually see.
 */
import "./preflight.mjs";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { launchChromium } from "./browser.mjs";
import { routeArtwork } from "./artwork-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".build", "rooms");
const workDir = path.join(root, ".build", "room-gallery");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(workDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "tools", "room-gallery.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(workDir, "gallery.js"),
  logLevel: "warning",
});

await writeFile(path.join(workDir, "index.html"), `<!doctype html>
<meta charset="utf-8">
<title>Room gallery</title>
<style>html,body{margin:0;background:#181c12}canvas{display:block}</style>
<script type="module" src="./gallery.js"></script>
`);

const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (request, response) => {
  const name = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  try {
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(path.join(workDir, path.basename(name)));
    response.writeHead(200, { "content-type": types[path.extname(name)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
try {
  const page = await browser.newPage({ viewport: { width: 980, height: 660 } });
  // Serve artwork from the SDK's sample sprite, so the gallery does not depend on the RPC.
  await routeArtwork(page);
  const failures = [];
  page.on("pageerror", error => failures.push(String(error)));
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.renderRoom === "function", { timeout: 20000 });

  const count = await page.evaluate(() => window.roomCount);
  await page.evaluate(i => window.renderRoom(i), 0);
  const spriteError = await page.evaluate(() => window.spriteError ?? null);
  if (spriteError) console.log(`  ! Friend artwork did not load: ${spriteError}`);
  for (let index = 0; index < count; index++) {
    await page.evaluate(i => window.renderRoom(i), index);
    const name = await page.evaluate(i => window.roomName(i), index);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const file = path.join(outDir, `${index}-${slug}.png`);
    await page.locator("#stage").screenshot({ path: file });
    console.log(`  · ${index} ${name}`);
  }
  // The winning sequence, sampled across its run.
  const escapeDir = path.join(outDir, "escape");
  await mkdir(escapeDir, { recursive: true });
  const marks = [0.04, 0.2, 0.38, 0.56, 0.74, 0.92];
  for (const [step, progress] of marks.entries()) {
    await page.evaluate(([t, won]) => window.renderEscape(t, won), [progress, true]);
    const file = path.join(escapeDir, `${step + 1}-escape-${Math.round(progress * 100)}.png`);
    await page.locator("#stage").screenshot({ path: file });
    console.log(`  · escape ${Math.round(progress * 100)}%`);
  }
  await page.evaluate(() => window.renderEscape(0.82, false));
  await page.locator("#stage").screenshot({ path: path.join(escapeDir, "7-escape-watching.png") });
  console.log("  · escape, seen by a losing agent");

  if (failures.length) {
    console.error("\nPage errors:");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\nRooms in ${outDir}`);
