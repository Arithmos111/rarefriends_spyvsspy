/**
 * Lobby matchmaking and authoritative match hosting over a same-origin WebSocket.
 *
 * The relay attaches to the same HTTP server that serves the FriendSDK bundle, which is
 * what lets the sandboxed game frame reach it: the SDK's child CSP allows connect-src
 * 'self', and nothing else.
 */
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import {
  INPUT_HZ, LOBBY_AUTOSTART_MS, LOBBY_IDLE_MS, LOBBY_MAX_PLAYERS, LOBBY_MIN_PLAYERS,
  MATCH_SECONDS, PROTOCOL_VERSION, TICK_MS,
  careerPointsFor, normaliseFriendName, stragglerClock, stragglerExpired,
} from "../games/rare-agency/shared/protocol.ts";
import { EXIT_RADIUS, EXIT_X, EXIT_Y } from "../games/rare-agency/shared/mansion.ts";
import { isKnownKit, kitById } from "../games/rare-agency/shared/loadouts.ts";
import { applyAction, applyInput, createMatch, dropPlayer, scoreOf, stepMatch } from "../games/rare-agency/shared/sim.ts";
import { buildSnapshot as snapshotFor, recapOf, scoreboardOf } from "../games/rare-agency/shared/view.ts";
import { holdsGenesis, ownerOfFriend, rpcConfigSummary } from "./rpc.mjs";
import { createLeaderboard } from "./leaderboard.mjs";
import { createStats } from "./stats.mjs";

const CODENAMES = [
  "FALCON", "VIPER", "MAGPIE", "OTTER", "JACKAL", "HERON", "KESTREL", "MARTEN",
  "ORIOLE", "BADGER", "LYNX", "PLOVER", "SABLE", "TERN", "WEASEL", "CONDOR",
];
const MAX_MESSAGE_BYTES = 4096;
const MESSAGES_PER_SECOND = 90;

const now = () => Date.now();
const code = () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

export function createRelay({ log = console.log } = {}) {
  /** @type {Map<string, any>} */ const players = new Map();
  /** @type {Map<string, any>} */ const lobbies = new Map();
  const wss = new WebSocketServer({ noServer: true });
  const leaderboard = createLeaderboard({ log });
  const stats = createStats({ log });
  const ready = Promise.all([
    leaderboard.load().catch(error => log(`leaderboard: ${error.message}`)),
    stats.load().catch(error => log(`stats: ${error.message}`)),
  ]);

  const send = (player, message) => {
    if (player.socket.readyState === 1) player.socket.send(JSON.stringify(message));
  };
  const fail = (player, message) => send(player, { t: "error", message });

  const lobbySummary = lobby => ({
    code: lobby.code, name: lobby.name, players: lobby.members.size, capacity: LOBBY_MAX_PLAYERS,
    state: lobby.state, isPrivate: lobby.isPrivate,
    host: players.get(lobby.hostId)?.codename ?? "—",
  });

  const publicLobbies = () => [...lobbies.values()]
    .filter(lobby => !lobby.isPrivate && lobby.state !== "playing" && lobby.members.size < LOBBY_MAX_PLAYERS)
    .sort((a, b) => b.members.size - a.members.size || a.createdAt - b.createdAt)
    .slice(0, 30)
    .map(lobbySummary);

  const activeMatches = () => [...lobbies.values()].filter(lobby => lobby.state === "playing").length;

  function sendLobbyList(player) {
    send(player, { t: "lobby.list", lobbies: publicLobbies(), onlinePlayers: players.size, activeMatches: activeMatches() });
  }

  function broadcastLobbyList() {
    for (const player of players.values()) if (!player.lobbyCode) sendLobbyList(player);
  }

  function lobbyState(lobby) {
    return {
      t: "lobby.state", code: lobby.code, name: lobby.name, isPrivate: lobby.isPrivate, state: lobby.state,
      startsInMs: lobby.startsAt ? Math.max(0, lobby.startsAt - now()) : null,
      members: [...lobby.members.entries()].map(([playerId, member]) => {
        const player = players.get(playerId);
        return {
          playerId, codename: player?.codename ?? "—", friendId: player?.friendId ?? "0",
          ready: member.ready, isHost: playerId === lobby.hostId, kitId: member.kitId,
          genesis: player?.genesis ?? false, friendName: player?.friendName ?? null,
        };
      }),
    };
  }

  function broadcastLobby(lobby) {
    const message = lobbyState(lobby);
    for (const playerId of lobby.members.keys()) {
      const player = players.get(playerId);
      if (player) send(player, message);
    }
  }

  function uniqueCodename(lobby, preferred) {
    const taken = new Set([...lobby.members.keys()].map(id => players.get(id)?.codename).filter(Boolean));
    if (!taken.has(preferred)) return preferred;
    for (const name of CODENAMES) if (!taken.has(name)) return name;
    return `${preferred}-${lobby.members.size + 1}`;
  }

  function joinLobby(player, lobby, kitId) {
    if (lobby.state === "playing") return fail(player, "That match has already started.");
    if (lobby.members.size >= LOBBY_MAX_PLAYERS) return fail(player, "That lobby is full.");
    leaveLobby(player, { silent: true });
    player.codename = uniqueCodename(lobby, player.codename);
    lobby.members.set(player.playerId, { ready: false, kitId: isKnownKit(kitId) ? kitId : "field" });
    lobby.lastActivity = now();
    player.lobbyCode = lobby.code;
    broadcastLobby(lobby);
    broadcastLobbyList();
  }

  function leaveLobby(player, { silent = false } = {}) {
    const lobby = lobbies.get(player.lobbyCode);
    player.lobbyCode = null;
    if (!lobby) return;
    lobby.members.delete(player.playerId);
    lobby.lastActivity = now();
    if (lobby.match) dropPlayer(lobby.match, player.playerId);
    if (lobby.hostId === player.playerId) lobby.hostId = [...lobby.members.keys()][0] ?? null;
    if (lobby.members.size === 0 && lobby.state !== "playing") closeLobby(lobby);
    else {
      if (lobby.state === "starting" && lobby.members.size < LOBBY_MIN_PLAYERS) {
        lobby.state = "waiting";
        lobby.startsAt = null;
      }
      broadcastLobby(lobby);
    }
    if (!silent) send(player, { t: "lobby.left" });
    broadcastLobbyList();
  }

  function closeLobby(lobby) {
    if (lobby.timer) clearInterval(lobby.timer);
    lobbies.delete(lobby.code);
  }

  /**
   * Mark when a lobby started waiting on its stragglers.
   *
   * The clock only runs while everyone else is ready, so a member is never dropped for
   * taking their time in a lobby that was not held up by them.
   */
  function trackStragglers(lobby) {
    const members = [...lobby.members.values()];
    const clocks = stragglerClock(members, now());
    members.forEach((member, index) => { member.holdingUpSince = clocks[index]; });
  }

  /** Remove anyone who has held a ready lobby up for too long. Returns true if any left. */
  function dropStragglers(lobby) {
    const at = now();
    let dropped = false;
    for (const [playerId, member] of [...lobby.members.entries()]) {
      if (!stragglerExpired(member.holdingUpSince ?? null, at)) continue;
      lobby.members.delete(playerId);
      dropped = true;
      const player = players.get(playerId);
      if (player) {
        player.lobby = null;
        send(player, { t: "lobby.left" });
        fail(player, "Removed from the lobby: everyone else was ready.");
      }
      log(`dropped an unready agent from lobby ${lobby.code}`);
    }
    if (dropped) {
      if (lobby.members.size === 0) closeLobby(lobby);
      else maybeAutoStart(lobby);
      broadcastLobbyList();
    }
    return dropped;
  }

  function maybeAutoStart(lobby) {
    trackStragglers(lobby);
    const ready = [...lobby.members.values()].filter(member => member.ready).length;
    const enough = lobby.members.size >= LOBBY_MIN_PLAYERS && ready === lobby.members.size;
    if (enough && lobby.state === "waiting") {
      lobby.state = "starting";
      lobby.startsAt = now() + LOBBY_AUTOSTART_MS;
    } else if (!enough && lobby.state === "starting") {
      lobby.state = "waiting";
      lobby.startsAt = null;
    }
    broadcastLobby(lobby);
    broadcastLobbyList();
  }

  function startMatch(lobby) {
    const roster = [...lobby.members.entries()].map(([playerId, member]) => {
      const player = players.get(playerId);
      return {
        playerId, friendId: player?.friendId ?? "0", codename: player?.codename ?? "AGENT",
        genesis: player?.genesis ?? false, kitId: member.kitId,
        friendName: player?.friendName ?? null,
      };
    });
    if (roster.length < LOBBY_MIN_PLAYERS) {
      lobby.state = "waiting";
      lobby.startsAt = null;
      broadcastLobby(lobby);
      return;
    }
    lobby.state = "playing";
    lobby.startsAt = null;
    lobby.match = createMatch((Math.random() * 0x7fffffff) | 0, roster, now());
    lobby.lastTick = now();

    const startMessage = {
      t: "match.start",
      roomNames: lobby.match.map.rooms.map(room => room.name),
      gridW: 3, gridH: 3, exitRoom: lobby.match.map.exitRoom,
      seed: lobby.match.seed,
    };
    for (const playerId of lobby.members.keys()) {
      const player = players.get(playerId);
      if (player) send(player, startMessage);
    }
    lobby.timer = setInterval(() => tickLobby(lobby), TICK_MS);
    stats.matchStarted(roster.length);
    broadcastLobbyList();
    log(`match started in lobby ${lobby.code} with ${roster.length} agents`);
  }

  function tickLobby(lobby) {
    const at = now();
    const delta = at - lobby.lastTick;
    lobby.lastTick = at;
    const match = lobby.match;
    if (!match) return;
    stepMatch(match, delta);

    const batch = match.events.splice(0, match.events.length);
    const cueBatch = match.cues.splice(0, match.cues.length);
    for (const playerId of lobby.members.keys()) {
      const player = players.get(playerId);
      if (!player) continue;
      send(player, buildSnapshot(match, playerId));
      const mine = batch.filter(event => !event.to || event.to === playerId)
        .map(({ at: eventAt, text, tone }) => ({ at: eventAt, text, tone }));
      if (mine.length) send(player, { t: "events", events: mine });
      const cues = cueBatch.filter(entry => entry.to === playerId).map(({ to, ...rest }) => rest);
      if (cues.length) send(player, { t: "cues", cues });
    }

    if (match.finished) endMatch(lobby);
  }

  function endMatch(lobby) {
    const match = lobby.match;
    if (lobby.timer) clearInterval(lobby.timer);
    lobby.timer = null;
    const results = scoreboard(match);
    const winner = match.winner ? match.players.get(match.winner) : null;

    // Fold this match into the career leaderboard, one row per Friend.
    for (const player of match.players.values()) {
      leaderboard.record(player.friendId, {
        codename: player.codename,
        friendName: player.friendName,
        won: match.winner === player.playerId,
        escaped: match.escaped,
        items: player.itemsFound,
        takedowns: player.takedowns,
        deaths: player.deaths,
        // Career points are turning up and winning, not the match score.
        points: careerPointsFor(match.winner === player.playerId),
      });
    }

    const recap = recapOf(match);
    const message = {
      t: "match.end", winner: match.winner, winnerName: winner?.codename ?? null,
      reason: match.endReason, escaped: match.escaped, results,
      recap,
    };

    // The operator page is fed the same recap the players are shown, so the totals behind the
    // counter and the numbers on their screen can never drift apart.
    stats.matchFinished({
      code: lobby.code,
      // The sim has no start stamp, but its deadline is fixed at creation, so elapsed time
      // is the whole match minus whatever was left on the clock.
      seconds: MATCH_SECONDS - (match.endsAt - match.now) / 1000,
      escaped: match.escaped,
      winner: winner?.codename ?? null,
      reason: match.endReason,
      recap,
    });
    for (const playerId of lobby.members.keys()) {
      const player = players.get(playerId);
      if (player) {
        // Each agent is told their own standing, worked out after this match was folded in.
        const seat = match.players.get(playerId);
        const standing = seat ? leaderboard.standing(seat.friendId) : null;
        const won = Boolean(seat && match.winner === seat.playerId);
        send(player, {
          ...message,
          career: standing ? { won, earned: careerPointsFor(won), ...standing } : null,
        });
      }
      const member = lobby.members.get(playerId);
      if (member) member.ready = false;
    }
    lobby.match = null;
    lobby.state = "waiting";
    lobby.lastActivity = now();
    if (lobby.members.size === 0) closeLobby(lobby);
    else broadcastLobby(lobby);
    broadcastLobbyList();
    log(`match ended in lobby ${lobby.code}: ${match.endReason}`);
  }

  const scoreboard = scoreboardOf;
  const buildSnapshot = (match, playerId) => snapshotFor(match, playerId);

  async function handleHello(player, message) {
    if (player.friendId) return;
    if (message.protocol !== PROTOCOL_VERSION) {
      fail(player, "This game build is out of date. Reload the page.");
      player.socket.close();
      return;
    }
    const friendId = String(message.friendId ?? "");
    if (!/^[0-9]{1,78}$/.test(friendId) || BigInt(friendId) <= 0n) {
      fail(player, "A verified Rare Friend is required to play.");
      player.socket.close();
      return;
    }
    player.friendId = friendId;
    stats.connected();
    player.codename = typeof message.codename === "string" && /^[A-Z0-9-]{3,12}$/.test(message.codename)
      ? message.codename
      : CODENAMES[Math.floor(Math.random() * CODENAMES.length)];

    // A real token check, plus the Genesis perk. Neither can block play if the RPC is down.
    const owner = await ownerOfFriend(friendId).catch(() => null);
    player.owner = owner;
    player.genesis = owner ? await holdsGenesis(owner).catch(() => false) : false;

    await ready;
    player.friendName = leaderboard.nameOf(friendId);

    send(player, {
      t: "hello.ok", playerId: player.playerId, codename: player.codename,
      genesis: player.genesis, protocol: PROTOCOL_VERSION,
      friendName: player.friendName,
    });
    sendLobbyList(player);
    send(player, { t: "leaderboard", rows: leaderboard.top(25) });
  }

  function handleMessage(player, raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message.t !== "string") return;

    if (message.t === "hello") return void handleHello(player, message);
    if (!player.friendId) return fail(player, "Identify your Rare Friend first.");
    if (message.t === "ping") return send(player, { t: "pong", at: message.at });

    const lobby = lobbies.get(player.lobbyCode);

    switch (message.t) {
      case "lobby.list": return sendLobbyList(player);

      case "leaderboard":
        return send(player, { t: "leaderboard", rows: leaderboard.top(25) });

      case "friend.name": {
        const stored = leaderboard.setName(player.friendId, message.name);
        player.friendName = stored;
        send(player, { t: "friend.name", friendName: stored });
        // A rename should show up immediately for everyone in the room.
        const current = lobbies.get(player.lobbyCode);
        if (current) {
          for (const entry of current.match?.players?.values() ?? []) {
            if (entry.playerId === player.playerId) entry.friendName = stored;
          }
          broadcastLobby(current);
        }
        return;
      }

      case "lobby.create": {
        if (lobbies.size > 400) return fail(player, "The server is at capacity. Try again shortly.");
        let newCode = code();
        while (lobbies.has(newCode)) newCode = code();
        const name = typeof message.name === "string" && message.name.trim()
          ? message.name.trim().slice(0, 28) : `${player.codename}'s embassy`;
        const created = {
          code: newCode, name, isPrivate: Boolean(message.isPrivate), hostId: player.playerId,
          members: new Map(), state: "waiting", startsAt: null, match: null, timer: null,
          createdAt: now(), lastActivity: now(),
        };
        lobbies.set(newCode, created);
        stats.lobbyOpened();
        return joinLobby(player, created, message.kitId);
      }

      case "lobby.join": {
        const target = lobbies.get(String(message.code ?? "").toUpperCase());
        if (!target) return fail(player, "No lobby with that code.");
        return joinLobby(player, target, message.kitId);
      }

      case "lobby.quick": {
        const open = [...lobbies.values()]
          .filter(entry => !entry.isPrivate && entry.state === "waiting" && entry.members.size < LOBBY_MAX_PLAYERS)
          .sort((a, b) => b.members.size - a.members.size)[0];
        if (open) return joinLobby(player, open, message.kitId);
        return handleMessage(player, JSON.stringify({ t: "lobby.create", name: "Quick match", isPrivate: false, kitId: message.kitId }));
      }

      case "lobby.leave": return leaveLobby(player);

      case "lobby.ready": {
        if (!lobby) return;
        const member = lobby.members.get(player.playerId);
        if (!member || lobby.state === "playing") return;
        member.ready = Boolean(message.ready);
        lobby.lastActivity = now();
        return maybeAutoStart(lobby);
      }

      case "lobby.kit": {
        if (!lobby) return;
        const member = lobby.members.get(player.playerId);
        if (!member || lobby.state === "playing") return;
        if (!isKnownKit(message.kitId)) return;
        member.kitId = message.kitId;
        return broadcastLobby(lobby);
      }

      case "lobby.start": {
        if (!lobby || lobby.hostId !== player.playerId) return;
        if (lobby.state === "playing") return;
        if (lobby.members.size < LOBBY_MIN_PLAYERS) return fail(player, `Wait for at least ${LOBBY_MIN_PLAYERS} agents.`);
        return startMatch(lobby);
      }

      case "input": {
        if (!lobby?.match) return;
        return applyInput(lobby.match, player.playerId, Number(message.seq) || 0, Number(message.dx) || 0, Number(message.dy) || 0);
      }

      case "action": {
        if (!lobby?.match || !message.action || typeof message.action.kind !== "string") return;
        return applyAction(lobby.match, player.playerId, message.action);
      }
    }
  }

  wss.on("connection", socket => {
    const player = {
      playerId: randomUUID(), socket, friendId: null, codename: null, genesis: false,
      friendName: null, owner: null, lobbyCode: null, budget: MESSAGES_PER_SECOND, alive: true,
    };
    players.set(player.playerId, player);

    socket.on("message", data => {
      if (data.length > MAX_MESSAGE_BYTES) return;
      if (player.budget-- <= 0) return;
      try { handleMessage(player, data.toString()); } catch (error) { log(`message error: ${error.message}`); }
    });
    socket.on("pong", () => { player.alive = true; });
    socket.on("close", () => {
      leaveLobby(player, { silent: true });
      players.delete(player.playerId);
      broadcastLobbyList();
    });
    socket.on("error", () => {});
  });

  // Budget refill, autostart, idle lobby reclamation and dead-socket pruning.
  const housekeeping = setInterval(() => {
    for (const player of players.values()) {
      player.budget = MESSAGES_PER_SECOND;
      if (!player.alive) { player.socket.terminate(); continue; }
      player.alive = false;
      if (player.socket.readyState === 1) player.socket.ping();
    }
    const at = now();
    // High-water marks, raised from the loop that is already running every second.
    stats.observe({ players: players.size, matches: activeMatches() });
    for (const lobby of [...lobbies.values()]) {
      if (lobby.state === "waiting") {
        // Run the clock here as well as on every ready change, so joining or leaving a lobby
        // starts it too rather than waiting for somebody to touch their ready button.
        trackStragglers(lobby);
        if (dropStragglers(lobby)) continue;
      }
      if (lobby.state === "starting" && lobby.startsAt && at >= lobby.startsAt) startMatch(lobby);
      if (lobby.members.size === 0 && at - lobby.lastActivity > LOBBY_IDLE_MS) closeLobby(lobby);
    }
  }, 1000);

  return {
    handleUpgrade(request, socket, head) {
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
    },
    stats() {
      return {
        players: players.size, lobbies: lobbies.size, matches: activeMatches(),
        careers: leaderboard.size(), rpc: rpcConfigSummary(),
      };
    },
    /** Everything the operator page shows: what is happening now, and what has happened. */
    report() {
      return {
        live: {
          players: players.size,
          lobbies: lobbies.size,
          openLobbies: publicLobbies().length,
          matches: activeMatches(),
        },
        careers: leaderboard.size(),
        top: leaderboard.top(10),
        rpc: rpcConfigSummary(),
        protocol: PROTOCOL_VERSION,
        totals: stats.snapshot(),
      };
    },
    leaderboard,
    stop() {
      clearInterval(housekeeping);
      for (const lobby of lobbies.values()) if (lobby.timer) clearInterval(lobby.timer);
      wss.close();
      return Promise.all([leaderboard.stop(), stats.stop()]);
    },
  };
}

export const RELAY_PATH = "/relay";
export { MATCH_SECONDS, INPUT_HZ, EXIT_RADIUS, EXIT_X, EXIT_Y, kitById };
