#!/usr/bin/env node
/**
 * Fetch, build and install FriendSDK v0.1 at a pinned commit.
 *
 * The SDK is published as UNLICENSED, so this repository does not redistribute it.
 * This script clones the pinned commit into vendor/, builds it, packs the tarball
 * the SDK's own README describes, and installs it into this project.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const vendor = path.join(root, "vendor");
const checkout = path.join(vendor, "friendsdk");
const source = JSON.parse(await readFile(path.join(root, "scripts/sdk-source.json"), "utf8"));

const exists = async target => access(target).then(() => true, () => false);
const step = message => console.log(`\n\x1b[38;5;154m▸\x1b[0m ${message}`);
const sh = async (command, args, cwd) => {
  const { stdout, stderr } = await run(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout;
};

if (process.argv.includes("--clean")) {
  step("Removing vendor/");
  await rm(vendor, { recursive: true, force: true });
}

await mkdir(vendor, { recursive: true });

if (!(await exists(path.join(checkout, ".git")))) {
  step(`Cloning FriendSDK from ${source.repository}`);
  await sh("git", ["clone", "--no-checkout", source.repository, checkout]);
}

step(`Checking out pinned commit ${source.commit.slice(0, 12)}`);
await sh("git", ["fetch", "--depth", "50", "origin", source.commit], checkout).catch(async () => {
  // Shallow fetch of a bare SHA is refused by some mirrors; fall back to a full fetch.
  await sh("git", ["fetch", "origin"], checkout);
});
await sh("git", ["checkout", "--force", source.commit], checkout);

const head = (await sh("git", ["rev-parse", "HEAD"], checkout)).trim();
if (head !== source.commit) throw new Error(`Expected FriendSDK commit ${source.commit} but the checkout is at ${head}.`);

step("Installing FriendSDK dependencies (npm ci)");
await sh("npm", ["ci"], checkout);

step("Building FriendSDK");
await sh("npm", ["run", "build"], checkout);

step("Packing FriendSDK");
const packed = path.join(vendor, `rarefriends-friendsdk-${source.version}.tgz`);
await rm(packed, { force: true });
await sh("npm", ["pack", "--ignore-scripts", "--pack-destination", vendor], checkout);
if (!(await exists(packed))) throw new Error(`npm pack did not produce ${packed}.`);

step("Installing project dependencies");
// package.json declares the SDK as file:vendor/..., so a plain install picks up the tarball
// just packed above and keeps it installed on later npm runs.
await sh("npm", ["install"], root);

console.log(`\n\x1b[38;5;154m✓ FriendSDK v${source.version} ready.\x1b[0m Run \x1b[1mnpm run dev\x1b[0m to play.\n`);
