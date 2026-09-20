#!/usr/bin/env node
/** Build the game with FriendSDK's bundler in watch mode and serve it with the relay attached. */
import { announce, attachRelay, GAME_DIR, loadSdkRunner, OUT_DIR, parseHostArgs } from "./host.mjs";

const { host, port } = parseHostArgs(process.argv.slice(2));
const { buildGame, createGameServer } = await loadSdkRunner();

const build = await buildGame(GAME_DIR, { watch: true, outdir: OUT_DIR });
const server = createGameServer(build.outdir);
const relay = attachRelay(server);

server.on("error", async error => {
  console.error(error.message);
  await build.close();
  process.exitCode = 1;
});

server.listen(port, host, () => announce({ host, port, mode: "development — refresh the browser after edits" }));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  relay.stop();
  server.closeAllConnections();
  server.close();
  await build.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
