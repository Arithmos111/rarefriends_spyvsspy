/**
 * The operator dashboard at /stats, and its machine-readable twin at /stats.json.
 *
 * Deliberately one self-contained HTML string with no build step, no framework and no
 * external requests: it has to work on a phone over a hotel wifi while a match is running,
 * and it must never be able to slow the relay down. It re-reads /stats.json on a timer
 * rather than holding a socket open.
 *
 * Read-only. There is no control here — nothing on this page can end a match, drop a player
 * or edit the standings.
 */
import { timingSafeEqual } from "node:crypto";

export const STATS_PATH = "/stats";
export const STATS_JSON_PATH = "/stats.json";

/**
 * Optional shared secret. Unset by default, because the page publishes nothing a player
 * cannot already see in game; set RF_STATS_TOKEN to require `?token=` on both routes.
 */
const TOKEN = process.env.RF_STATS_TOKEN || "";

/** Constant-time compare, so a wrong token cannot be guessed a character at a time. */
function tokenOk(given) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escapeHtml = value => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function duration(seconds) {
  if (!seconds) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function ago(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return `${duration(seconds)} ago`;
}

function renderPage(report) {
  const { live, totals, top, rpc, careers, protocol } = report;
  const tile = (label, value, note = "") => `
    <div class="tile">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${escapeHtml(value)}</div>
      ${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}
    </div>`;

  // Fourteen days is what fits on a phone without scrolling sideways.
  const days = Object.entries(totals.days).sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  const busiest = Math.max(1, ...days.map(([, d]) => d.matches));
  const bars = days.map(([key, day]) => `
    <div class="bar" title="${escapeHtml(key)}: ${day.matches} matches, ${day.seats} seats, ${day.connections} arrivals">
      <div class="fill" style="height:${Math.round((day.matches / busiest) * 100)}%"></div>
      <span>${escapeHtml(key.slice(5))}</span>
    </div>`).join("");

  const endings = Object.entries(totals.endings)
    .map(([kind, count]) => `<li><strong>${count}</strong> ${escapeHtml(kind)}</li>`).join("");

  const recent = totals.recent.length
    ? totals.recent.map(match => `
      <tr>
        <td>${escapeHtml(ago(match.at))}</td>
        <td class="mono">${escapeHtml(match.code)}</td>
        <td class="num">${match.players}</td>
        <td class="num">${escapeHtml(clock(match.seconds))}</td>
        <td><span class="pill pill-${escapeHtml(match.ending)}">${escapeHtml(match.ending)}</span></td>
        <td>${escapeHtml(match.winner ?? "—")}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No matches have finished yet.</td></tr>`;

  const board = top.length
    ? top.map((row, index) => `
      <tr>
        <td class="num">${index + 1}</td>
        <td>${escapeHtml(row.friendName ? `${row.codename} (${row.friendName})` : row.codename)}
            <small>#${escapeHtml(row.friendId)}</small></td>
        <td class="num">${row.points}</td>
        <td class="num">${row.matches}</td>
        <td class="num">${row.wins}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">Nobody on the board yet.</td></tr>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>The Rare Agency — relay statistics</title>
<style>
  :root{--ink:#14180f;--paper:#eef1e4;--void:#181c12;--signal:#ccff00;--alert:#e4572e;--muted:#8b9378}
  *{box-sizing:border-box}
  body{margin:0;background:var(--void);color:var(--paper);
       font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:20px}
  main{max-width:1000px;margin:0 auto}
  h1{font-size:18px;letter-spacing:.18em;margin:0 0 4px}
  h2{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);
     margin:28px 0 10px;border-bottom:1px solid #2c331f;padding-bottom:6px}
  .sub{color:var(--muted);margin:0 0 4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .tile{background:#1f2416;border:1px solid #2c331f;border-radius:8px;padding:12px}
  .tile .label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .tile .value{font-size:26px;font-weight:700;color:var(--signal);font-variant-numeric:tabular-nums}
  .tile .note{font-size:11px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10px;letter-spacing:.12em;text-transform:uppercase;
     color:var(--muted);font-weight:400;padding:6px 8px}
  td{padding:6px 8px;border-top:1px solid #2c331f}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  td.mono{font-family:inherit;letter-spacing:.1em}
  td small{color:var(--muted)}
  td.empty{color:var(--muted);text-align:center;padding:18px}
  .pill{font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;
        border-radius:999px;border:1px solid var(--muted);color:var(--muted)}
  .pill-escape{border-color:var(--signal);color:var(--signal)}
  .pill-timeout{border-color:#e8c547;color:#e8c547}
  .pill-abandoned,.pill-stalemate{border-color:var(--alert);color:var(--alert)}
  ul.endings{list-style:none;display:flex;flex-wrap:wrap;gap:16px;padding:0;margin:14px 0 0;color:var(--muted)}
  ul.endings strong{color:var(--paper);font-size:16px}
  .chart{display:flex;align-items:flex-end;gap:5px;height:120px;margin-top:6px}
  .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
  .bar .fill{width:100%;min-height:2px;background:var(--signal);border-radius:2px 2px 0 0}
  .bar span{font-size:9px;color:var(--muted);margin-top:4px;white-space:nowrap}
  footer{margin-top:30px;color:var(--muted);font-size:11px}
  a{color:var(--signal)}
</style>
</head><body><main>
  <h1>THE RARE AGENCY</h1>
  <p class="sub">Relay statistics · up ${escapeHtml(duration(totals.uptimeSeconds))} ·
     protocol ${escapeHtml(protocol)} · refreshes every 10s</p>

  <h2>Right now</h2>
  <div class="grid">
    ${tile("Players online", live.players)}
    ${tile("Matches running", live.matches)}
    ${tile("Lobbies", live.lobbies, `${live.openLobbies} open to join`)}
    ${tile("Friends on record", careers)}
  </div>

  <h2>All time</h2>
  <div class="grid">
    ${tile("Matches finished", totals.matchesFinished, `${totals.matchesStarted} started`)}
    ${tile("Average length", clock(totals.averageMatchSeconds), `${totals.averageSeats} agents a match`)}
    ${tile("Seats played", totals.seats, `${totals.connections} arrivals`)}
    ${tile("Peak concurrent", totals.peakPlayers, `${totals.peakMatches} matches at once`)}
    ${tile("Intelligence taken", totals.itemsRecovered)}
    ${tile("Takedowns", totals.takedowns, `${totals.deaths} agents lost`)}
    ${tile("Blows landed", totals.hits, `${totals.damage} damage`)}
    ${tile("Power-ups", totals.powerUps)}
  </div>
  <ul class="endings">${endings}</ul>

  <h2>Matches a day</h2>
  <div class="chart">${bars || '<span class="empty">Nothing yet.</span>'}</div>

  <h2>Last matches</h2>
  <table>
    <thead><tr><th>When</th><th>Lobby</th><th class="num">Agents</th>
      <th class="num">Length</th><th>Ending</th><th>Winner</th></tr></thead>
    <tbody>${recent}</tbody>
  </table>

  <h2>Career standings</h2>
  <table>
    <thead><tr><th class="num">#</th><th>Friend</th><th class="num">Points</th>
      <th class="num">Matches</th><th class="num">Wins</th></tr></thead>
    <tbody>${board}</tbody>
  </table>

  <footer>
    Counting since ${escapeHtml(totals.since)} · last match ${escapeHtml(ago(totals.lastMatchAt))} ·
    RPC ${escapeHtml(rpc?.url ?? "unknown")} ·
    <a href="${STATS_JSON_PATH}">raw JSON</a>
    <br>Read-only. Nothing on this page can change a match, a player or the standings.
  </footer>
</main>
<script>
  // Re-render by reloading rather than patching the DOM: the page is small, and a reload
  // cannot drift out of step with the server the way a hand-written patch can.
  setTimeout(() => location.reload(), 10000);
</script>
</body></html>`;
}

/**
 * Handle /stats and /stats.json. Returns true when it answered, so the caller can fall
 * through to the SDK's own static file server for everything else.
 */
export function handleStatsRequest(request, response, report) {
  let url;
  try { url = new URL(request.url, "http://localhost"); } catch { return false; }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== STATS_PATH && path !== STATS_JSON_PATH) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Allow": "GET, HEAD" }).end();
    return true;
  }
  if (!tokenOk(url.searchParams.get("token"))) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Not found\n");
    return true;
  }

  const headers = {
    // Always fresh: a cached dashboard is worse than no dashboard.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    // The relay is the only thing this page talks to, and it loads nothing from anywhere.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  };

  let body, type;
  try {
    const data = report();
    if (path === STATS_JSON_PATH) {
      type = "application/json; charset=utf-8";
      body = JSON.stringify(data, null, 2);
    } else {
      type = "text/html; charset=utf-8";
      body = renderPage(data);
    }
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
      .end(`Statistics unavailable: ${error.message}\n`);
    return true;
  }

  const buffer = Buffer.from(body);
  response.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": buffer.length });
  response.end(request.method === "HEAD" ? undefined : buffer);
  return true;
}
