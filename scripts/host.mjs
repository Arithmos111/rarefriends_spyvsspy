/**
 * Shared hosting helper.
 *
 * The SDK's own runner exports the bundler and the static server it uses, so this reuses
 * both verbatim: the sandbox document, its Content-Security-Policy and the generated-files-only
 * serving policy are exactly what FriendSDK ships. The only addition is a WebSocket upgrade
 * handler on the same origin, which the child CSP's `connect-src 'self'` already permits.
 */
import { access } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRelay, RELAY_PATH } from "../server/relay.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const GAME_DIR = path.join(root, "games/embassy-run");
export const OUT_DIR = path.join(root, ".build/game");

export async function loadSdkRunner() {
  // The package's export map exposes neither package.json nor scripts/, so resolve the
  // main entry point and walk back up to the package root from dist/index.js.
  let runnerPath;
  try {
    const entry = fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"));
    runnerPath = path.join(path.dirname(path.dirname(entry)), "scripts/dev-game.mjs");
    await access(runnerPath);
  } catch {
    throw new Error(
      "FriendSDK is not installed. Run `npm run setup` first — it fetches, builds and installs the pinned SDK commit.",
    );
  }
  return import(pathToFileURL(runnerPath).href);
}

export function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter(entry => entry && entry.family === "IPv4" && !entry.internal)
    .map(entry => entry.address);
}

export function parseHostArgs(argv) {
  let host = process.env.HOST ?? "0.0.0.0";
  let port = Number(process.env.PORT ?? 4173);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host" && argv[i + 1]) host = argv[++i];
    else if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535.");
  return { host, port };
}

export function attachRelay(server, { log = console.log } = {}) {
  const relay = createRelay({ log });
  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url, "http://localhost").pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== RELAY_PATH) { socket.destroy(); return; }
    relay.handleUpgrade(request, socket, head);
  });
  return relay;
}

export function announce({ host, port, mode }) {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const green = text => `\x1b[38;5;154m${text}\x1b[0m`;
  console.log(`\n  ${green("EMBASSY RUN")}  ${mode}`);
  console.log(`  ${green("→")} this computer   http://${shown}:${port}`);
  if (host === "0.0.0.0" || host === "::") {
    for (const address of lanAddresses()) {
      console.log(`  ${green("→")} phone on wifi   http://${address}:${port}`);
    }
  }
  console.log(`\n  Connect a wallet holding a Rare Friends Generations NFT (generation 1+) on`);
  console.log(`  Robinhood mainnet, pick your Friend, then create or join a lobby.`);
  console.log(`  Open the URL in a second browser or on your phone to play against yourself.\n`);
}
