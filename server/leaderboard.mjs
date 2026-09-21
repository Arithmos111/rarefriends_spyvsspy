/**
 * Career totals per Rare Friend, kept across every match this relay has hosted.
 *
 * Backed by a single JSON file so standings survive a restart or redeploy. Writes are
 * debounced and atomic: a temporary file is renamed into place, so a crash mid-write
 * leaves the previous standings intact rather than a truncated file.
 *
 * Trust model note: the relay cannot prove a client controls the Friend ID it claims,
 * because the sandboxed game frame has no signer. Standings are therefore as trustworthy
 * as that claim. This is recorded as a capability gap in the submission.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normaliseFriendName } from "../games/rare-agency/shared/protocol.ts";

const DATA_DIR = process.env.RF_DATA_DIR ?? path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "leaderboard.json");
const SAVE_DEBOUNCE_MS = 2000;
const MAX_ROWS = 500;

const blank = (friendId) => ({
  friendId, friendName: null, codename: "AGENT",
  matches: 0, wins: 0, escapes: 0, items: 0, takedowns: 0, deaths: 0, points: 0,
});

export function createLeaderboard({ log = () => {} } = {}) {
  /** @type {Map<string, any>} */
  let rows = new Map();
  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(FILE, "utf8"));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.rows)) {
        for (const row of parsed.rows) {
          if (typeof row?.friendId !== "string") continue;
          rows.set(row.friendId, { ...blank(row.friendId), ...row, friendId: row.friendId });
        }
      }
      log(`leaderboard: loaded ${rows.size} career rows`);
    } catch (error) {
      if (error.code !== "ENOENT") log(`leaderboard: starting fresh (${error.message})`);
    }
  }

  async function flush() {
    if (!dirty) return;
    dirty = false;
    // Keep the file bounded; the tail of a long leaderboard is not worth unbounded disk.
    const ordered = [...rows.values()].sort((a, b) => b.points - a.points).slice(0, MAX_ROWS);
    const body = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), rows: ordered }, null, 0);
    await mkdir(DATA_DIR, { recursive: true });
    const temporary = `${FILE}.${process.pid}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, FILE);
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = saving.then(flush).catch(error => log(`leaderboard: save failed: ${error.message}`));
    }, SAVE_DEBOUNCE_MS);
    if (typeof saveTimer.unref === "function") saveTimer.unref();
  }

  function rowFor(friendId) {
    let row = rows.get(friendId);
    if (!row) { row = blank(friendId); rows.set(friendId, row); }
    return row;
  }

  return {
    load,

    /** The stored display name for a Friend, or null. */
    nameOf(friendId) {
      return rows.get(friendId)?.friendName ?? null;
    },

    /** Set or clear a Friend's display name. Returns the value actually stored. */
    setName(friendId, value) {
      const name = normaliseFriendName(value);
      const row = rowFor(friendId);
      row.friendName = name;
      scheduleSave();
      return name;
    },

    /** Record one finished match for one agent. */
    record(friendId, { codename, friendName, won, escaped, items, takedowns, deaths, points }) {
      const row = rowFor(friendId);
      if (codename) row.codename = codename;
      if (friendName !== undefined && friendName !== null) row.friendName = friendName;
      row.matches += 1;
      if (won) row.wins += 1;
      if (won && escaped) row.escapes += 1;
      row.items += items;
      row.takedowns += takedowns;
      row.deaths += deaths;
      row.points += points;
      scheduleSave();
    },

    top(limit = 25) {
      return [...rows.values()]
        .filter(row => row.matches > 0)
        .sort((a, b) => b.points - a.points || b.wins - a.wins || a.deaths - b.deaths)
        .slice(0, limit);
    },

    size() { return rows.size; },

    async stop() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await saving;
      await flush().catch(() => {});
    },
  };
}
