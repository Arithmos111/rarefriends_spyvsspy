/**
 * Operator statistics: what this relay has actually hosted.
 *
 * Separate from the career leaderboard, which is per-Friend and player-facing. This is the
 * view from behind the counter — how many matches ran, how they ended, how busy it got — so
 * the preview can be watched while people play it without reading the log.
 *
 * Persisted the same way the leaderboard is: one JSON file, debounced, written to a temporary
 * file and renamed into place, so a crash mid-write leaves the previous totals intact rather
 * than a truncated file. Counters survive a restart; anything live (who is online right now)
 * is recomputed and never stored.
 *
 * Nothing here records a wallet address, an IP or anything else a player did not already
 * publish in game. Friend token ids and codenames appear, exactly as they do on the in-game
 * scoreboard.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.RF_DATA_DIR ?? path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "stats.json");
const SAVE_DEBOUNCE_MS = 5000;
/** Recent matches kept for the page's activity list. */
const RECENT_MATCHES = 25;
/** Daily buckets kept, so the file cannot grow without bound. */
const DAYS_KEPT = 30;

const today = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

const blank = () => ({
  version: 1,
  /** When this relay first recorded anything, across all restarts. */
  since: new Date().toISOString(),
  matchesStarted: 0,
  matchesFinished: 0,
  /** How matches ended. A match with no winner at the whistle is a stalemate. */
  endings: { escape: 0, timeout: 0, stalemate: 0, abandoned: 0 },
  /** Seconds of match time hosted, for the average-length figure. */
  matchSeconds: 0,
  /** Seats filled across all matches: four players in one match counts four. */
  seats: 0,
  lobbiesOpened: 0,
  connections: 0,
  itemsRecovered: 0,
  takedowns: 0,
  deaths: 0,
  hits: 0,
  damage: 0,
  powerUps: 0,
  peakPlayers: 0,
  peakMatches: 0,
  /** One bucket per calendar day (UTC), trimmed to DAYS_KEPT. */
  days: {},
  /** The most recent finished matches, newest first. */
  recent: [],
  lastMatchAt: null,
});

export function createStats({ log = () => {} } = {}) {
  let totals = blank();
  const startedAt = Date.now();
  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(FILE, "utf8"));
      if (parsed && parsed.version === 1) {
        totals = { ...blank(), ...parsed, endings: { ...blank().endings, ...parsed.endings } };
        totals.days = parsed.days ?? {};
        totals.recent = Array.isArray(parsed.recent) ? parsed.recent : [];
      }
      log(`stats: loaded ${totals.matchesFinished} finished matches`);
    } catch (error) {
      if (error.code !== "ENOENT") log(`stats: starting fresh (${error.message})`);
    }
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    trimDays();
    await mkdir(DATA_DIR, { recursive: true });
    const temporary = `${FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...totals, savedAt: new Date().toISOString() }));
    await rename(temporary, FILE);
  }

  function trimDays() {
    const keys = Object.keys(totals.days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) delete totals.days[key];
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = saving.then(flush).catch(error => log(`stats: save failed: ${error.message}`));
    }, SAVE_DEBOUNCE_MS);
    if (typeof saveTimer.unref === "function") saveTimer.unref();
  }

  function dayBucket(at) {
    const key = today(at);
    totals.days[key] ??= { matches: 0, seats: 0, connections: 0 };
    return totals.days[key];
  }

  return {
    load,

    /** A wallet connected and identified a Friend. */
    connected(at = Date.now()) {
      totals.connections += 1;
      dayBucket(at).connections += 1;
      scheduleSave();
    },

    lobbyOpened() {
      totals.lobbiesOpened += 1;
      scheduleSave();
    },

    matchStarted(seatCount, at = Date.now()) {
      totals.matchesStarted += 1;
      totals.seats += seatCount;
      const bucket = dayBucket(at);
      bucket.matches += 1;
      bucket.seats += seatCount;
      scheduleSave();
    },

    /**
     * One finished match. `recap` is the same per-agent table the players are shown, so the
     * totals here and the numbers on their recap screen can never drift apart.
     */
    matchFinished({ code, seconds, escaped, winner, reason, recap = [] }, at = Date.now()) {
      totals.matchesFinished += 1;
      totals.matchSeconds += Math.max(0, Math.round(seconds));
      totals.lastMatchAt = new Date(at).toISOString();

      const ending = escaped ? "escape"
        : !recap.length ? "abandoned"
        : winner ? "timeout" : "stalemate";
      totals.endings[ending] = (totals.endings[ending] ?? 0) + 1;

      for (const row of recap) {
        totals.itemsRecovered += row.items ?? 0;
        totals.takedowns += row.takedowns ?? 0;
        totals.deaths += row.deaths ?? 0;
        totals.hits += row.hits ?? 0;
        totals.damage += row.damageDealt ?? 0;
        totals.powerUps += row.powerUps ?? 0;
      }

      totals.recent.unshift({
        at: new Date(at).toISOString(),
        code, seconds: Math.max(0, Math.round(seconds)),
        players: recap.length, ending,
        winner: winner ?? null,
        reason: reason ?? "",
      });
      totals.recent.length = Math.min(totals.recent.length, RECENT_MATCHES);
      scheduleSave();
    },

    /** Called from housekeeping; only ever raises the high-water marks. */
    observe({ players, matches }) {
      let changed = false;
      if (players > totals.peakPlayers) { totals.peakPlayers = players; changed = true; }
      if (matches > totals.peakMatches) { totals.peakMatches = matches; changed = true; }
      if (changed) scheduleSave();
    },

    /** Everything recorded, plus this process's uptime. Safe to serialise as-is. */
    snapshot() {
      trimDays();
      return {
        ...totals,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        averageMatchSeconds: totals.matchesFinished
          ? Math.round(totals.matchSeconds / totals.matchesFinished) : 0,
        averageSeats: totals.matchesStarted
          ? Math.round((totals.seats / totals.matchesStarted) * 10) / 10 : 0,
      };
    },

    async stop() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await saving;
      await flush().catch(() => {});
    },
  };
}
