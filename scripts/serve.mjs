#!/usr/bin/env node
/** Serve an existing build with the relay. Used for deployment; run `npm run build` first. */
import "./preflight.mjs";
import { access } from "node:fs/promises";
import path from "node:path";
const { announce, attachRelay, loadSdkRunner, OUT_DIR, parseHostArgs } = await import("./host.mjs");

const { host, port } = parseHostArgs(process.argv.slice(2));
await access(path.join(OUT_DIR, "index.html")).catch(() => {
  throw new Error("No build found. Run `npm run build` first.");
});

const { createGameServer } = await loadSdkRunner();
const server = createGameServer(OUT_DIR);
const relay = attachRelay(server);
server.listen(port, host, () => announce({ host, port, mode: "production" }));

const close = () => { relay.stop(); server.closeAllConnections(); server.close(); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
