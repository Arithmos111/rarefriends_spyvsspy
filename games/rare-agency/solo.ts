/**
 * Demo mode.
 *
 * A full match against CPU agents, run entirely in this browser. It exists for the two
 * moments a multiplayer game is at its worst: nobody is in the lobby, and you want to try
 * something without wasting a real match on it.
 *
 * Like the training run, it steps the real simulation and publishes the real snapshot shape,
 * so every rule, every sound and every score is the live game's. Unlike the training run it
 * is a genuine match: a five-minute clock, four mission items, a winner, an escape sequence
 * and a recap. It just does not touch the relay, which means it also does not touch the
 * career standings — nothing you do against a computer belongs on the leaderboard.
 */
import {
  LOBBY_MAX_PLAYERS, type MatchSnapshot, type PlayerAction, type RecapRow,
} from "./shared/protocol.ts";
import {
  applyInput, createMatch, stepMatch, applyAction, type MatchSim,
} from "./shared/sim.ts";
import { buildSnapshot, recapOf } from "./shared/view.ts";
import { createCpu, driveCpu, type CpuMemory, type Difficulty } from "./shared/cpu.ts";

export const SOLO_PLAYER = "solo";

/** Codenames for the opposition, so the scoreboard reads like a lobby rather than a test rig. */
const CPU_CODENAMES = ["MAGPIE", "SABLE", "OSPREY"] as const;

/** Friend ids the demo opposition are drawn with. Low ids are certain to have artwork. */
const CPU_FRIEND_IDS = ["2", "3", "4"] as const;

export type SoloState = {
  sim: MatchSim;
  cpus: CpuMemory[];
  difficulty: Difficulty;
  /** Set once the match has ended, so the caller knows to show the recap. */
  finished: boolean;
};

export type SoloOptions = {
  difficulty?: Difficulty;
  /** Total agents in the match, this player included. */
  players?: number;
  friendId?: string;
  codename?: string;
  kitId?: string;
  seed?: number;
  now?: number;
};

export function startSolo(options: SoloOptions = {}): SoloState {
  const difficulty = options.difficulty ?? "agent";
  const total = Math.max(2, Math.min(LOBBY_MAX_PLAYERS, options.players ?? 2));
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const now = options.now ?? 0;

  const roster = [{
    playerId: SOLO_PLAYER,
    friendId: options.friendId ?? "1",
    codename: options.codename ?? "AGENT",
    genesis: false,
    kitId: options.kitId ?? "field",
    friendName: null,
  }];
  for (let i = 0; i < total - 1; i++) {
    roster.push({
      playerId: `cpu${i + 1}`,
      friendId: CPU_FRIEND_IDS[i] ?? String(i + 2),
      codename: CPU_CODENAMES[i] ?? `UNIT-${i + 1}`,
      genesis: false,
      kitId: "field",
      friendName: null,
    });
  }

  const sim = createMatch(seed, roster, now);
  const cpus = roster.slice(1).map((entry, index) =>
    // A seed per agent, so two CPUs in the same room do not roll in lockstep.
    createCpu(entry.playerId, difficulty, seed + (index + 1) * 7919));
  return { sim, cpus, difficulty, finished: false };
}

/**
 * One tick. Mirrors the relay's order exactly: every agent's input and actions are applied,
 * then the simulation steps once for everybody.
 */
export function stepSolo(state: SoloState, deltaMs: number, dx: number, dy: number): void {
  if (state.finished) return;
  // Sequence numbers must strictly increase, and tick is still on the previous value here.
  applyInput(state.sim, SOLO_PLAYER, state.sim.tick + 1, dx, dy);
  for (const cpu of state.cpus) driveCpu(state.sim, cpu);
  stepMatch(state.sim, deltaMs);
  if (state.sim.finished) state.finished = true;
}

export function soloAction(state: SoloState, action: PlayerAction): void {
  if (state.finished) return;
  applyAction(state.sim, SOLO_PLAYER, action);
  if (state.sim.finished) state.finished = true;
}

export function soloSnapshot(state: SoloState): MatchSnapshot {
  return buildSnapshot(state.sim, SOLO_PLAYER);
}

export function soloRecap(state: SoloState): RecapRow[] {
  return recapOf(state.sim);
}

/** True when this player was the one who got out, for the escape sequence's verdict. */
export function soloWon(state: SoloState): boolean {
  return state.sim.winner === SOLO_PLAYER;
}
