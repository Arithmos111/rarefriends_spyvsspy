#!/usr/bin/env node
/**
 * Game validation, mirroring FriendSDK's own scripts/check-games.mjs so this directory stays
 * drop-in valid inside an SDK checkout: the definition parses, the README exists, the
 * component bundles, wallet transport never reaches game code, and nothing outside the game
 * directory or the SDK is pulled into the bundle.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const gameDir = path.join(root, "games/embassy-run");
const sdkEntry = fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"));
const sdkRoot = path.dirname(path.dirname(sdkEntry));
const { parseChanceGame, expectedReward, maximumPrize } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/game.js")).href);

const packageJson = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
const definition = parseChanceGame(JSON.parse(await readFile(path.join(gameDir, "game.json"), "utf8")));
await access(path.join(gameDir, "README.md"));

const result = await build({
  absWorkingDir: root,
  entryPoints: [path.join(gameDir, "index.tsx")],
  bundle: true, platform: "browser", format: "esm", target: "es2022", jsx: "automatic",
  write: false, outdir: "unused", metafile: true,
  external: ["react", "react/jsx-runtime", "react-dom/client"],
  loader: { ".png": "file", ".jpg": "file", ".webp": "file", ".svg": "file", ".woff2": "file", ".mp3": "file", ".wav": "file" },
  assetNames: "assets/[name]-[hash]",
  plugins: [
    {
      name: "sdk-exports",
      setup(builder) {
        builder.onResolve({ filter: /^@rarefriends\/friendsdk(?:\/|$)/ }, args => {
          if (args.path === "@rarefriends/friendsdk/host") {
            return { errors: [{ text: "Wallet transport belongs to the SDK runtime, not game code." }] };
          }
          const name = args.path.replace("@rarefriends/friendsdk", ".") || ".";
          const entry = packageJson.exports[name];
          if (!entry) return { errors: [{ text: `Unknown SDK export: ${args.path}` }] };
          return { path: path.join(sdkRoot, typeof entry === "string" ? entry : entry.import) };
        });
      },
    },
  ],
});

for (const source of Object.keys(result.metafile.inputs)) {
  const full = path.resolve(root, source);
  if (["src/chain.ts", "dist/chain.js"].includes(path.relative(sdkRoot, full))) {
    throw new Error("wallet transport belongs to the host, not the game frame");
  }
  const local = path.relative(gameDir, full);
  const insideGame = !local.startsWith(`..${path.sep}`) && local !== "..";
  // Exactly the SDK's own rule for games/: the game directory, or the SDK's dist/, src/ and
  // node_modules/. Notably NOT the SDK's assets/ — the runner injects its stylesheets itself.
  const allowedSdk = ["dist", "src", "node_modules"]
    .some(folder => full.startsWith(path.join(sdkRoot, folder) + path.sep));
  const insideModules = full.startsWith(path.join(root, "node_modules") + path.sep);
  if (!insideGame && !allowedSdk && !insideModules) {
    throw new Error(`undeclared source outside the game/SDK: ${source}`);
  }
}

const bytes = result.outputFiles.reduce((total, file) => total + file.contents.length, 0);
const weights = definition.outcomes.reduce((total, outcome) => total + outcome.chanceBps, 0);
assert.equal(weights, 10_000, "outcome weights must total 10,000 basis points");
const expected = expectedReward(definition);
const maximum = maximumPrize(definition);
assert.ok(expected < definition.price, "expected reward must stay below the crate price");

const rf = value => `${(Number(value) / 1e18).toFixed(3)} RF`;
console.log(`games/embassy-run: valid`);
console.log(`  consumable       ${definition.consumable} at ${rf(definition.price)}`);
console.log(`  outcomes         ${definition.outcomes.length}, weights total ${weights} bps`);
console.log(`  expected reward  ${rf(expected)} (${(Number(expected) / Number(definition.price) * 100).toFixed(1)}% of price)`);
console.log(`  maximum prize    ${rf(maximum)} reserved per crate`);
console.log(`  bundle           ${(bytes / 1024).toFixed(0)} KiB`);
