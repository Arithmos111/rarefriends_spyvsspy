#!/usr/bin/env node
/** Produce the static bundle in .build/game for deployment alongside the relay. */
import { GAME_DIR, loadSdkRunner, OUT_DIR } from "./host.mjs";

const { buildGame } = await loadSdkRunner();
const build = await buildGame(GAME_DIR, { watch: false, outdir: OUT_DIR });
console.log(`Built ${build.outdir}`);
