#!/usr/bin/env node
/**
 * Validate this game with the SDK's own checker.
 *
 * FriendSDK 0.1.2 exports `checkGame` for exactly this — "in either an SDK checkout or a
 * consuming project" — so the rule is the SDK's rather than a copy of it kept here. The
 * hand-written mirror this replaces had already drifted once: it rejected a stylesheet import
 * the SDK itself permits, because 0.1.2 relaxed the source rule to allow `assets/`.
 */
import "./preflight.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GAME_DIR } from "./host.mjs";

const sdkEntry = path.dirname(path.dirname(
  (await import("node:url")).fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"))));
const { checkGame } = await import(
  pathToFileURL(path.join(sdkEntry, "scripts/check-games.mjs")).href);

try {
  console.log(await checkGame(GAME_DIR));
} catch (cause) {
  console.error(`\nGame validation failed:\n  ✗ ${cause instanceof Error ? cause.message : cause}\n`);
  process.exitCode = 1;
}
