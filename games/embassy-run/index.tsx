"use client";

/**
 * Embassy Run — a four-player Spy vs Spy-style stealth match for FriendSDK v0.1.
 *
 * The SDK runtime owns wallet connection, owned-Friend discovery and the fresh Generations
 * ownership check; this component only receives the verified friendId, the fixed action
 * client and the pause flag. Every purchase, crate opening and redemption here is simulated
 * by the SDK's preview client. Match outcomes are decided by an authoritative relay on this
 * page's own origin, never by the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GamePlay, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendReader } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";

import { createNet, type Net, type NetStatus } from "./net.ts";
import { drawEmbassy, unproject, VIEW_H, VIEW_W } from "./render.ts";
import {
  INPUT_MS, INTERACT_RANGE, MATCH_SECONDS, MISSION_ITEMS, MISSION_ITEM_LABELS, ROOM_H, ROOM_W,
  TRAP_LABELS, TRAP_TYPES,
  type LobbyMember, type LobbySummary, type MatchEvent, type MatchSnapshot,
  type PublicPlayer, type ServerMessage, type TrapType,
} from "./shared/protocol.ts";
import { EXIT_RADIUS, EXIT_X, EXIT_Y, createMap, type EmbassyMap } from "./shared/mansion.ts";
import { KITS, FIELD_KIT_ID, kitById } from "./shared/loadouts.ts";
import { movePlayer, type Facing } from "./shared/sim.ts";
import "./style.css";

type Screen = "briefing" | "lobby" | "match" | "results";
type Menu = "crate" | "kits" | "settings" | "join" | "create" | "reveal" | "traps" | null;

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

type LobbyView = {
  code: string; name: string; isPrivate: boolean;
  members: readonly LobbyMember[]; state: "waiting" | "starting" | "playing"; startsInMs: number | null;
};

export default function EmbassyRun({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;

  // ---- FriendSDK simulated economy -----------------------------------------------------
  const [economy, setEconomy] = useState<GameSnapshot | null>(null);
  const [economyError, setEconomyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reveal, setReveal] = useState<GamePlay | null>(null);

  // ---- Relay / session ------------------------------------------------------------------
  const [netStatus, setNetStatus] = useState<NetStatus>("connecting");
  const [identity, setIdentity] = useState<{ playerId: string; codename: string; genesis: boolean } | null>(null);
  const [lobbies, setLobbies] = useState<readonly LobbySummary[]>([]);
  const [serverStats, setServerStats] = useState({ onlinePlayers: 0, activeMatches: 0 });
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [match, setMatch] = useState<MatchSnapshot | null>(null);
  const [results, setResults] = useState<{ winnerName: string | null; reason: string; results: readonly PublicPlayer[] } | null>(null);
  const [feed, setFeed] = useState<readonly MatchEvent[]>([]);
  const [relayError, setRelayError] = useState("");

  // ---- Presentation ---------------------------------------------------------------------
  const [menu, setMenu] = useState<Menu>(null);
  const [equippedKit, setEquippedKit] = useState<string>(FIELD_KIT_ID);
  const [muted, setMuted] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [lobbyName, setLobbyName] = useState("");
  const [privateLobby, setPrivateLobby] = useState(false);
  const [spriteTick, setSpriteTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const netRef = useRef<Net | null>(null);
  const soundRef = useRef<FriendSoundKit | null>(null);
  const spritesRef = useRef(new Map<string, any>());
  const readerRef = useRef<ReturnType<typeof createFriendReader> | null>(null);
  const mapRef = useRef<EmbassyMap | null>(null);
  const predictedRef = useRef<{ room: number; x: number; y: number; facing: Facing; walking: boolean }>(
    { room: 0, x: 0, y: 0, facing: "down", walking: false });
  const heldRef = useRef(new Set<string>());
  const stickRef = useRef({ dx: 0, dy: 0, active: false });
  const walkToRef = useRef<{ x: number; y: number; room: number } | null>(null);
  const seqRef = useRef(1);
  const matchRef = useRef<MatchSnapshot | null>(null);
  const pausedRef = useRef(paused);
  const menuRef = useRef<Menu>(null);
  const reducedRef = useRef(false);
  const screenRef = useRef<Screen>("briefing");

  matchRef.current = match;
  pausedRef.current = paused;
  menuRef.current = menu;
  reducedRef.current = reducedMotion;

  const screen: Screen = results ? "results" : match ? "match" : lobby ? "lobby" : "briefing";
  screenRef.current = screen;

  const inputBlocked = paused || menu !== null;

  // ---- Economy wiring -------------------------------------------------------------------
  const refreshEconomy = useCallback(async () => {
    try {
      const next = await client.read();
      setEconomy(next);
      setEconomyError("");
    } catch (cause) {
      setEconomyError(cause instanceof Error ? cause.message : "The simulated ledger could not be read.");
    }
  }, [client]);

  useEffect(() => {
    soundRef.current = createFriendSoundKit({ muted: true });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(preference.matches);
    sync();
    preference.addEventListener("change", sync);
    void refreshEconomy();
    return () => {
      preference.removeEventListener("change", sync);
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, [refreshEconomy]);

  const act = useCallback(async (work: () => Promise<void>, cue?: FriendSoundCue, message?: string) => {
    if (busy || paused) return;
    setBusy(true);
    setNotice("");
    void soundRef.current?.unlock();
    try {
      await work();
      await refreshEconomy();
      if (cue) soundRef.current?.play(cue);
      if (message) setNotice(message);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "That simulated action failed.");
    } finally {
      setBusy(false);
    }
  }, [busy, paused, refreshEconomy]);

  const ownedKits = useMemo(() => {
    const inventory = economy?.inventory ?? [];
    return KITS.map(kit => ({
      kit,
      owned: kit.outcomeId === null ? 1n : (inventory[kit.outcomeId - 1] ?? 0n),
    }));
  }, [economy]);

  useEffect(() => {
    // Drop back to the free kit if a redemption removed the equipped one.
    const entry = ownedKits.find(item => item.kit.id === equippedKit);
    if (entry && entry.owned === 0n) setEquippedKit(FIELD_KIT_ID);
  }, [ownedKits, equippedKit]);

  // ---- Relay wiring ---------------------------------------------------------------------
  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.t) {
      case "hello.ok":
        setIdentity({ playerId: message.playerId, codename: message.codename, genesis: message.genesis });
        setRelayError("");
        break;
      case "lobby.list":
        setLobbies(message.lobbies);
        setServerStats({ onlinePlayers: message.onlinePlayers, activeMatches: message.activeMatches });
        break;
      case "lobby.state":
        setLobby({
          code: message.code, name: message.name, isPrivate: message.isPrivate,
          members: message.members, state: message.state, startsInMs: message.startsInMs,
        });
        setResults(null);
        setMenu(current => (current === "join" || current === "create" ? null : current));
        break;
      case "lobby.left":
        setLobby(null);
        setMatch(null);
        break;
      case "match.start": {
        mapRef.current = createMap(message.seed);
        walkToRef.current = null;
        setResults(null);
        setFeed([]);
        seqRef.current = 1;
        break;
      }
      case "snapshot": {
        const previous = matchRef.current;
        setMatch(message);
        const self = message.self;
        const predicted = predictedRef.current;
        if (!previous || previous.roomIndex !== message.roomIndex || predicted.room !== message.roomIndex
          || distance(predicted.x, predicted.y, self.x, self.y) > 64) {
          predictedRef.current = { room: message.roomIndex, x: self.x, y: self.y, facing: self.facing, walking: self.walking };
        } else {
          // Gentle correction keeps the local agent responsive without drifting off the server.
          predicted.x += (self.x - predicted.x) * 0.2;
          predicted.y += (self.y - predicted.y) * 0.2;
        }
        break;
      }
      case "events":
        setFeed(current => [...current, ...message.events].slice(-6));
        break;
      case "match.end":
        setResults({ winnerName: message.winnerName, reason: message.reason, results: message.results });
        setMatch(null);
        soundRef.current?.play(message.winner && message.winner === identityRef.current?.playerId ? "reward" : "reveal-common");
        break;
      case "error":
        setRelayError(message.message);
        break;
    }
  }, []);

  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    const net = createNet({ onMessage: handleMessage, onStatus: setNetStatus });
    netRef.current = net;
    net.identify(friendId, "");
    return () => { net.close(); netRef.current = null; };
  }, [friendId, handleMessage]);

  useEffect(() => {
    if (screen !== "briefing" || netStatus !== "online") return;
    const timer = setInterval(() => netRef.current?.send({ t: "lobby.list" }), 3000);
    netRef.current?.send({ t: "lobby.list" });
    return () => clearInterval(timer);
  }, [screen, netStatus]);

  // ---- Sprite loading -------------------------------------------------------------------
  useEffect(() => {
    if (!match) return;
    readerRef.current ??= createFriendReader();
    const reader = readerRef.current;
    const wanted = new Set<string>([match.self.friendId, ...match.actors.map(actor => actor.friendId)]);
    let cancelled = false;
    for (const id of wanted) {
      if (spritesRef.current.has(id)) continue;
      spritesRef.current.set(id, "loading");
      reader.read(BigInt(id))
        .then(sprites => { if (!cancelled) { spritesRef.current.set(id, sprites); setSpriteTick(value => value + 1); } })
        .catch(() => { if (!cancelled) { spritesRef.current.set(id, "error"); setSpriteTick(value => value + 1); } });
    }
    return () => { cancelled = true; };
  }, [match?.self.friendId, match?.actors.map(actor => actor.friendId).join(","), match]);

  // ---- Interaction targets --------------------------------------------------------------
  type Targets = {
    furniture: MatchSnapshot["furniture"][number] | null;
    drop: MatchSnapshot["drops"][number] | null;
    atGate: boolean;
    /** Nearest furniture regardless of reach, used for the walk-to hint and checks. */
    nearest: MatchSnapshot["furniture"][number] | null;
  };
  const emptyTargets: Targets = { furniture: null, drop: null, atGate: false, nearest: null };
  const targetsRef = useRef<Targets>(emptyTargets);
  const [targets, setTargets] = useState<Targets>(emptyTargets);

  const computeTargets = useCallback((snapshot: MatchSnapshot | null): Targets => {
    if (!snapshot) return emptyTargets;
    const { x, y } = predictedRef.current;
    let nearest: MatchSnapshot["furniture"][number] | null = null;
    let nearestGap = Infinity;
    for (const piece of snapshot.furniture) {
      const gap = distance(x, y, piece.x, piece.y);
      if (gap < nearestGap) { nearestGap = gap; nearest = piece; }
    }
    let drop: MatchSnapshot["drops"][number] | null = null;
    let bestDrop = INTERACT_RANGE;
    for (const item of snapshot.drops) {
      const gap = distance(x, y, item.x, item.y);
      if (gap <= bestDrop) { bestDrop = gap; drop = item; }
    }
    return {
      furniture: nearestGap <= INTERACT_RANGE ? nearest : null,
      drop,
      atGate: snapshot.exitHere && distance(x, y, EXIT_X, EXIT_Y) <= EXIT_RADIUS,
      nearest,
    };
  }, []);

  // ---- Input ----------------------------------------------------------------------------
  const sendAction = useCallback((action: Parameters<Net["send"]>[0] extends never ? never : any) => {
    netRef.current?.send({ t: "action", seq: seqRef.current++, action });
  }, []);

  const primaryAction = useCallback(() => {
    const current = targetsRef.current;
    if (current.atGate) return sendAction({ kind: "escape" });
    if (current.drop) return sendAction({ kind: "pickup", dropId: current.drop.id });
    if (current.furniture) return sendAction({ kind: "search", furnitureId: current.furniture.id });
  }, [sendAction]);

  const plantTrap = useCallback((trap: TrapType) => {
    const piece = targetsRef.current.furniture;
    if (!piece) return;
    sendAction({ kind: "plant", furnitureId: piece.id, trap });
    setMenu(null);
  }, [sendAction]);

  useEffect(() => {
    const keyMap: Record<string, [number, number]> = {
      arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1],
      arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0],
    };
    const normalise = (key: string) => (key.length === 1 ? key.toLowerCase() : key.toLowerCase());
    const down = (event: KeyboardEvent) => {
      if (pausedRef.current || screenRef.current !== "match") return;
      const key = normalise(event.key);
      if (keyMap[key]) {
        if (menuRef.current) return;
        heldRef.current.add(key);
        event.preventDefault();
        return;
      }
      if (event.repeat) return;
      if (key === "escape") { setMenu(null); return; }
      if (menuRef.current) return;
      if (key === "e" || key === " ") { event.preventDefault(); primaryAction(); }
      else if (key === "f") { event.preventDefault(); sendAction({ kind: "attack" }); }
      else if (key === "q") { event.preventDefault(); setMenu("traps"); }
      else if (key === "1" || key === "2" || key === "3") {
        event.preventDefault();
        plantTrap(TRAP_TYPES[Number(key) - 1]);
      }
    };
    const up = (event: KeyboardEvent) => { heldRef.current.delete(normalise(event.key)); };
    const clear = () => heldRef.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
      clear();
    };
  }, [primaryAction, sendAction, plantTrap]);

  useEffect(() => { if (inputBlocked) heldRef.current.clear(); }, [inputBlocked]);

  const inputVector = useCallback((): [number, number] => {
    if (inputBlocked || screenRef.current !== "match") return [0, 0];
    if (stickRef.current.active) { walkToRef.current = null; return [stickRef.current.dx, stickRef.current.dy]; }
    let dx = 0, dy = 0;
    const keyMap: Record<string, [number, number]> = {
      arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1],
      arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0],
    };
    for (const key of heldRef.current) {
      const vector = keyMap[key];
      if (vector) { dx += vector[0]; dy += vector[1]; }
    }
    const magnitude = Math.hypot(dx, dy);
    if (magnitude > 0) { walkToRef.current = null; return magnitude > 1 ? [dx / magnitude, dy / magnitude] : [dx, dy]; }

    // Walk toward a tapped destination until it is reached or another input takes over.
    const destination = walkToRef.current;
    if (destination) {
      const { x, y, room } = predictedRef.current;
      if (destination.room !== room) { walkToRef.current = null; return [0, 0]; }
      const gapX = destination.x - x, gapY = destination.y - y;
      const gap = Math.hypot(gapX, gapY);
      if (gap < 7) { walkToRef.current = null; return [0, 0]; }
      return [gapX / gap, gapY / gap];
    }
    return [0, 0];
  }, [inputBlocked]);

  // Input transmission at a fixed rate, independent of frame rate.
  useEffect(() => {
    const timer = setInterval(() => {
      if (screenRef.current !== "match") return;
      const [dx, dy] = inputVector();
      netRef.current?.send({ t: "input", seq: seqRef.current++, dx, dy });
    }, INPUT_MS);
    return () => clearInterval(timer);
  }, [inputVector]);

  // ---- Render loop ----------------------------------------------------------------------
  useEffect(() => {
    if (screen !== "match") return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.focus({ preventScroll: true });
    let frame = 0;
    let previous = performance.now();

    const loop = (nowMs: number) => {
      const delta = Math.min(50, nowMs - previous);
      previous = nowMs;
      const snapshot = matchRef.current;
      const embassy = mapRef.current;
      if (snapshot && embassy) {
        const self = snapshot.self;
        const canMove = !self.busy && self.stunnedMs <= 0 && self.respawnMs <= 0 && !pausedRef.current;
        if (canMove) {
          const [dx, dy] = inputVector();
          movePlayer(embassy, predictedRef.current, dx, dy, delta);
        } else {
          predictedRef.current.walking = false;
        }

        const next = computeTargets(snapshot);
        const previousTargets = targetsRef.current;
        targetsRef.current = next;
        if (previousTargets.furniture?.id !== next.furniture?.id
          || previousTargets.drop?.id !== next.drop?.id
          || previousTargets.atGate !== next.atGate
          || previousTargets.nearest?.id !== next.nearest?.id
          || previousTargets.furniture?.trap !== next.furniture?.trap) {
          setTargets(next);
        }

        // Mirrors the SDK world view's data-x/data-y convention for automated checks.
        canvas.dataset.x = predictedRef.current.x.toFixed(1);
        canvas.dataset.y = predictedRef.current.y.toFixed(1);
        canvas.dataset.room = String(snapshot.roomIndex);
        canvas.dataset.near = next.nearest ? String(next.nearest.id) : "";
        canvas.dataset.nearX = next.nearest ? String(next.nearest.x) : "";
        canvas.dataset.nearY = next.nearest ? String(next.nearest.y) : "";
        canvas.dataset.inReach = next.furniture ? "1" : "0";

        drawEmbassy(context, {
          snapshot,
          selfX: predictedRef.current.x,
          selfY: predictedRef.current.y,
          sprites: spritesRef.current,
          nearestFurnitureId: targetsRef.current.furniture?.id ?? null,
          nearestDropId: targetsRef.current.drop?.id ?? null,
          reducedMotion: reducedRef.current,
          timeMs: nowMs,
        });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [screen, inputVector, computeTargets]);

  const onCanvasPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (inputBlocked || !matchRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const sx = (event.clientX - rect.left) * VIEW_W / rect.width;
    const sy = (event.clientY - rect.top) * VIEW_H / rect.height;
    const [wx, wy] = unproject(sx, sy);
    const snapshot = matchRef.current;
    const me = predictedRef.current;

    // Tapping something already within reach uses it; otherwise walk to the tapped spot.
    for (const drop of snapshot.drops) {
      if (distance(wx, wy, drop.x, drop.y) < 34 && distance(me.x, me.y, drop.x, drop.y) <= INTERACT_RANGE) {
        sendAction({ kind: "pickup", dropId: drop.id });
        return;
      }
    }
    for (const piece of snapshot.furniture) {
      if (distance(wx, wy, piece.x, piece.y) < 44 && distance(me.x, me.y, piece.x, piece.y) <= INTERACT_RANGE) {
        sendAction({ kind: "search", furnitureId: piece.id });
        return;
      }
    }
    if (snapshot.exitHere && distance(wx, wy, EXIT_X, EXIT_Y) < EXIT_RADIUS
      && distance(me.x, me.y, EXIT_X, EXIT_Y) <= EXIT_RADIUS) {
      sendAction({ kind: "escape" });
      return;
    }
    walkToRef.current = {
      x: Math.max(0, Math.min(ROOM_W, wx)),
      y: Math.max(0, Math.min(ROOM_H, wy)),
      room: snapshot.roomIndex,
    };
  }, [inputBlocked, sendAction]);

  // ---- Lobby commands -------------------------------------------------------------------
  const send = useCallback((message: Parameters<Net["send"]>[0]) => netRef.current?.send(message), []);
  const quickMatch = () => send({ t: "lobby.quick", kitId: equippedKit });
  const createLobby = () => {
    send({ t: "lobby.create", name: lobbyName.trim(), isPrivate: privateLobby, kitId: equippedKit });
    setLobbyName("");
  };
  const joinLobby = (code: string) => { send({ t: "lobby.join", code: code.toUpperCase(), kitId: equippedKit }); setJoinCode(""); };
  const leaveLobby = () => { send({ t: "lobby.leave" }); setLobby(null); setMatch(null); setResults(null); };
  const toggleReady = () => {
    const me = lobby?.members.find(member => member.playerId === identity?.playerId);
    send({ t: "lobby.ready", ready: !me?.ready });
  };

  useEffect(() => {
    if (lobby) send({ t: "lobby.kit", kitId: equippedKit });
  }, [equippedKit, lobby?.code, send]);

  // ---- Derived view data ----------------------------------------------------------------
  const maxPrize = maximumPrize(definition);
  const canBuy = Boolean(economy && economy.rfBalance >= definition.price
    && economy.freeStake + definition.price >= maxPrize);
  const pendingPlay = economy?.plays.find(play => play.outcomeId === null) ?? null;
  const crateCount = economy?.consumables ?? 0n;

  const openCrate = () => act(async () => {
    const play = pendingPlay ?? (await client.play(1n))[0];
    const settled = await client.settle(play.id);
    setReveal(settled);
    setMenu("reveal");
  }, "reveal-common");

  const me = lobby?.members.find(member => member.playerId === identity?.playerId) ?? null;
  const isHost = me?.isHost ?? false;

  // ---- Screens --------------------------------------------------------------------------
  if (economyError && !economy) {
    return <section className="er-shell er-center" role="alert">
      <h1>Embassy Run</h1>
      <p>{economyError}</p>
      <button type="button" className="er-primary" disabled={busy || paused} onClick={() => void refreshEconomy()}>Retry</button>
    </section>;
  }
  if (!economy) {
    return <section className="er-shell er-center" role="status">
      <h1>Embassy Run</h1>
      <p>Opening the diplomatic pouch…</p>
    </section>;
  }
  if (economy.friendId !== friendId) {
    return <section className="er-shell er-center" role="alert">
      <h1>Embassy Run</h1>
      <p>This session does not match the selected Rare Friend. Reselect your Friend to continue.</p>
    </section>;
  }

  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const statusLine = netStatus === "online"
    ? `Relay online · ${plural(serverStats.onlinePlayers, "agent", "agents")} · ${plural(serverStats.activeMatches, "match", "matches")}`
    : netStatus === "connecting" ? "Contacting the relay…" : "Relay offline — reconnecting…";

  return <section className="er-shell" aria-label={definition.name} aria-busy={busy}>
    {screen !== "match" && <header className="er-top">
      <div className="er-brand">
        <strong>EMBASSY RUN</strong>
        <span className="er-sim">Simulated RF</span>
      </div>
      <div className="er-status">
        <span className={`er-dot er-dot-${netStatus}`} aria-hidden="true" />
        <span>{statusLine}</span>
      </div>
    </header>}

    {relayError && <p className="er-banner" role="alert">{relayError}</p>}

    {screen === "briefing" && <BriefingScreen
      economy={economy} definition={definition} rf={rf} crateCount={crateCount} canBuy={canBuy}
      maxPrize={maxPrize} busy={busy} paused={paused} notice={notice}
      identity={identity} friendId={friendId} equippedKit={equippedKit}
      ownedKits={ownedKits} lobbies={lobbies} netStatus={netStatus}
      onBuy={() => void act(() => client.buy(1n), "purchase", "One simulated Gadget Crate added.")}
      onOpen={() => void openCrate()}
      onSetMenu={setMenu} onQuick={quickMatch} onJoin={joinLobby}
      pendingPlay={Boolean(pendingPlay)}
    />}

    {screen === "lobby" && lobby && <LobbyScreen
      lobby={lobby} identity={identity} isHost={isHost} me={me}
      equippedKit={equippedKit} onKit={() => setMenu("kits")}
      onReady={toggleReady} onStart={() => send({ t: "lobby.start" })} onLeave={leaveLobby}
    />}

    {screen === "match" && match && <MatchScreen
      match={match} feed={feed} targets={targets} canvasRef={canvasRef}
      onCanvasPointer={onCanvasPointer} onPrimary={primaryAction}
      onAttack={() => sendAction({ kind: "attack" })}
      onTraps={() => setMenu("traps")}
      onDisarm={() => targets.furniture && sendAction({ kind: "disarm", furnitureId: targets.furniture.id })}
      onSettings={() => setMenu("settings")}
      stickRef={stickRef} inputBlocked={inputBlocked} reducedMotion={reducedMotion}
      netStatus={netStatus}
    />}

    {screen === "results" && results && <ResultsScreen
      results={results} identity={identity} onBack={leaveLobby}
      onAgain={() => { setResults(null); }} inLobby={Boolean(lobby)}
    />}

    {menu && <GameMenu
      title={menu === "crate" ? "Gadget crate" : menu === "kits" ? "Your kits" : menu === "settings" ? "Settings"
        : menu === "join" ? "Join by code" : menu === "create" ? "Create a lobby"
        : menu === "reveal" ? "Crate opened" : "Set a trap"}
      onClose={busy ? undefined : () => setMenu(null)}>

      {menu === "crate" && <div className="er-menu">
        <p>One crate costs {rf(definition.price)} and opens into exactly one gadget kit.</p>
        <table className="er-table">
          <thead><tr><th>Kit</th><th>Chance</th><th>Redeems for</th></tr></thead>
          <tbody>{definition.outcomes.map(outcome => <tr key={outcome.name}>
            <td>{outcome.name}</td><td>{outcome.chanceBps / 100}%</td><td>{rf(outcome.reward)}</td>
          </tr>)}</tbody>
        </table>
        <p className="er-fine">Every crate reserves {rf(maxPrize)} of simulated backing. All values are simulated.</p>
      </div>}

      {menu === "reveal" && reveal && <div className="er-reveal">
        {(() => {
          const outcome = reveal.outcomeId ? definition.outcomes[reveal.outcomeId - 1] : null;
          const kit = reveal.outcomeId ? KITS.find(entry => entry.outcomeId === reveal.outcomeId) : null;
          if (!outcome || !kit) return <p>That crate is still settling. Reopen it from the briefing room.</p>;
          return <>
            <h3>{outcome.name}</h3>
            <p className="er-fine">{outcome.chanceBps / 100}% chance · redeems for {rf(outcome.reward)}</p>
            <p>{kit.blurb}</p>
            <ul className="er-kitlist">
              {TRAP_TYPES.map(type => <li key={type}>{TRAP_LABELS[type]} × {kit.traps[type]}</li>)}
              {kit.detector && <li>Trap detector</li>}
              {kit.lockpick && <li>Lockpick</li>}
              {kit.disarm && <li>Disarm tool</li>}
            </ul>
            <button type="button" className="er-primary" disabled={busy || paused}
              onClick={() => { setEquippedKit(kit.id); setMenu(null); setNotice(`${kit.name} equipped.`); }}>
              Equip {kit.name}
            </button>
            <button type="button" disabled={busy || paused} onClick={() => setMenu(null)}>Keep in the locker</button>
          </>;
        })()}
      </div>}

      {menu === "kits" && <div className="er-menu">
        <p>Kits are permanent. Equipping one is free and unlimited; redeeming one converts it to simulated RF and removes it.</p>
        <div className="er-kits">
          {ownedKits.map(({ kit, owned }) => <div key={kit.id} className={`er-kit${equippedKit === kit.id ? " er-kit-on" : ""}`}>
            <div className="er-kit-head">
              <strong>{kit.name}</strong>
              <span>{kit.outcomeId === null ? "always issued" : `${owned.toString()} owned`}</span>
            </div>
            <p className="er-fine">{kit.blurb}</p>
            <ul className="er-kitlist">
              {TRAP_TYPES.map(type => kit.traps[type] > 0 && <li key={type}>{TRAP_LABELS[type]} × {kit.traps[type]}</li>)}
              {kit.detector && <li>Detector</li>}
              {kit.lockpick && <li>Lockpick</li>}
              {kit.disarm && <li>Disarm tool</li>}
            </ul>
            <div className="er-kit-actions">
              <button type="button" disabled={owned === 0n || busy || paused || equippedKit === kit.id}
                onClick={() => { setEquippedKit(kit.id); setNotice(`${kit.name} equipped.`); }}>
                {equippedKit === kit.id ? "Equipped" : "Equip"}
              </button>
              {kit.outcomeId !== null && <button type="button" disabled={owned === 0n || busy || paused}
                onClick={() => void act(() => client.redeem(kit.outcomeId!, 1n), "reward", `${kit.name} redeemed for simulated RF.`)}>
                Redeem {rf(definition.outcomes[kit.outcomeId - 1].reward)}
              </button>}
            </div>
          </div>)}
        </div>
      </div>}

      {menu === "traps" && <div className="er-menu">
        {!match ? <p>Traps can only be set during a match.</p> : !targets.furniture
          ? <p>Stand beside a piece of furniture to set a trap in it.</p>
          : <>
            <p>Set a trap inside the {targets.furniture.type}. Anyone who searches it, except you, springs it.</p>
            <div className="er-trapgrid">
              {TRAP_TYPES.map((type, index) => {
                const count = match.self.traps[type] ?? 0;
                return <button key={type} type="button" className="er-trapbutton"
                  disabled={count <= 0 || Boolean(targets.furniture?.trap)}
                  onClick={() => plantTrap(type)}>
                  <strong>{TRAP_LABELS[type]}</strong>
                  <span>{count} left · key {index + 1}</span>
                </button>;
              })}
            </div>
            {targets.furniture.trap && <p className="er-fine">This furniture already holds a trap.</p>}
          </>}
      </div>}

      {menu === "join" && <div className="er-menu">
        <label className="er-field">Lobby code
          <input value={joinCode} maxLength={4} autoCapitalize="characters" inputMode="text"
            onChange={event => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
        </label>
        <button type="button" className="er-primary" disabled={joinCode.length < 4 || netStatus !== "online"}
          onClick={() => joinLobby(joinCode)}>Join lobby</button>
      </div>}

      {menu === "create" && <div className="er-menu">
        <label className="er-field">Lobby name
          <input value={lobbyName} maxLength={28} placeholder="Night shift"
            onChange={event => setLobbyName(event.target.value)} />
        </label>
        <label className="er-check">
          <input type="checkbox" checked={privateLobby} onChange={event => setPrivateLobby(event.target.checked)} />
          Private — joinable by code only
        </label>
        <button type="button" className="er-primary" disabled={netStatus !== "online"} onClick={createLobby}>Create lobby</button>
      </div>}

      {menu === "settings" && <div className="er-menu">
        <button type="button" aria-pressed={!muted} onClick={() => {
          const next = !muted;
          setMuted(next);
          soundRef.current?.setMuted(next);
          if (!next) void soundRef.current?.unlock();
        }}>{muted ? "Sound off" : "Sound on"}</button>
        <label className="er-check">
          <input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)} />
          Reduce motion
        </label>
        <p className="er-fine">
          Movement: WASD or arrow keys, or the on-screen stick. E or the action button searches, picks up
          and escapes. F strikes. Q or the trap button sets a trap; 1, 2 and 3 set one directly.
        </p>
        <p className="er-fine">
          All RF balances, crates, kits and redemptions are simulated by FriendSDK's preview client.
          Match results are decided by the relay server, not by this browser.
        </p>
      </div>}

      {notice && <p className="er-notice" role="status">{notice}</p>}
    </GameMenu>}
  </section>;
}

// ---------------------------------------------------------------------------------------

function BriefingScreen(props: any) {
  const {
    economy, definition, rf, crateCount, canBuy, maxPrize, busy, paused, notice, identity,
    friendId, equippedKit, ownedKits, lobbies, netStatus, onBuy, onOpen, onSetMenu, onQuick,
    onJoin, pendingPlay,
  } = props;
  const kit = kitById(equippedKit);
  return <div className="er-briefing">
    <div className="er-panel er-dossier">
      <h2>Agent dossier</h2>
      <dl>
        <div><dt>Codename</dt><dd>{identity?.codename ?? "—"}{identity?.genesis && <span className="er-badge">GENESIS</span>}</dd></div>
        <div><dt>Rare Friend</dt><dd>#{friendId.toString()}</dd></div>
        <div><dt>Simulated RF</dt><dd>{rf(economy.rfBalance)}</dd></div>
        <div><dt>Crates held</dt><dd>{crateCount.toString()}</dd></div>
        <div><dt>Equipped kit</dt><dd>{kit.name}</dd></div>
      </dl>
      <div className="er-row">
        <button type="button" disabled={!canBuy || busy || paused} onClick={onBuy}>
          Buy crate · {rf(definition.price)}
        </button>
        <button type="button" disabled={busy || paused || (crateCount === 0n && !pendingPlay)} onClick={onOpen}>
          {pendingPlay ? "Finish opening" : "Open crate"}
        </button>
        <button type="button" disabled={busy || paused} onClick={() => onSetMenu("kits")}>Kits</button>
        <button type="button" disabled={busy || paused} onClick={() => onSetMenu("crate")}>Odds</button>
      </div>
      {!canBuy && <p className="er-fine">
        {economy.rfBalance < definition.price
          ? "Not enough simulated RF for another crate."
          : `Purchases pause until ${rf(maxPrize)} of free backing is available.`}
      </p>}
      {notice && <p className="er-notice" role="status">{notice}</p>}
    </div>

    <div className="er-panel er-lobbies">
      <div className="er-panel-head">
        <h2>Open lobbies</h2>
        <div className="er-row">
          <button type="button" className="er-primary" disabled={netStatus !== "online"} onClick={onQuick}>Quick match</button>
          <button type="button" disabled={netStatus !== "online"} onClick={() => onSetMenu("create")}>Create</button>
          <button type="button" disabled={netStatus !== "online"} onClick={() => onSetMenu("join")}>Code</button>
        </div>
      </div>
      {netStatus !== "online"
        ? <p className="er-empty">Waiting for the relay…</p>
        : lobbies.length === 0
          ? <p className="er-empty">No open lobbies. Create one and share its code, or start a quick match.</p>
          : <ul className="er-lobbylist">
            {lobbies.map((entry: LobbySummary) => <li key={entry.code}>
              <div>
                <strong>{entry.name}</strong>
                <span className="er-fine">{entry.code} · host {entry.host} · {entry.state}</span>
              </div>
              <div className="er-row">
                <span className="er-count">{entry.players}/{entry.capacity}</span>
                <button type="button" onClick={() => onJoin(entry.code)}>Join</button>
              </div>
            </li>)}
          </ul>}
      <p className="er-fine">Up to four agents per embassy. Dozens can play at once across separate lobbies.</p>
    </div>
  </div>;
}

function LobbyScreen({ lobby, identity, isHost, me, equippedKit, onKit, onReady, onStart, onLeave }: any) {
  const countdown = lobby.startsInMs !== null ? Math.ceil(lobby.startsInMs / 1000) : null;
  return <div className="er-lobbyroom">
    <div className="er-panel">
      <div className="er-panel-head">
        <h2>{lobby.name}</h2>
        <span className="er-code">CODE {lobby.code}{lobby.isPrivate ? " · private" : ""}</span>
      </div>
      <ul className="er-roster">
        {lobby.members.map((member: LobbyMember) => <li key={member.playerId}
          className={member.playerId === identity?.playerId ? "er-me" : ""}>
          <span className="er-roster-name">
            {member.codename}{member.genesis && <span className="er-badge">GENESIS</span>}
            {member.isHost && <span className="er-host">HOST</span>}
          </span>
          <span className="er-fine">Friend #{member.friendId} · {kitById(member.kitId).name}</span>
          <span className={member.ready ? "er-ready" : "er-waiting"}>{member.ready ? "READY" : "waiting"}</span>
        </li>)}
        {Array.from({ length: Math.max(0, 4 - lobby.members.length) }).map((_, index) =>
          <li key={`empty-${index}`} className="er-slot-empty"><span>Empty slot</span></li>)}
      </ul>
      {countdown !== null && <p className="er-countdown" role="status">Match begins in {countdown}…</p>}
      <div className="er-row">
        <button type="button" className="er-primary" onClick={onReady}>{me?.ready ? "Stand down" : "Ready"}</button>
        <button type="button" onClick={onKit}>Kit: {kitById(equippedKit).name}</button>
        {isHost && <button type="button" onClick={onStart} disabled={lobby.members.length < 2}>Start now</button>}
        <button type="button" onClick={onLeave}>Leave</button>
      </div>
      <p className="er-fine">
        Find all four pieces of intelligence hidden in the embassy's furniture, then reach the
        courtyard gate in the centre room. Trap the furniture behind you.
      </p>
    </div>
  </div>;
}

function MatchScreen(props: any) {
  const {
    match, feed, targets, canvasRef, onCanvasPointer, onPrimary, onAttack, onTraps,
    onDisarm, onSettings, stickRef, inputBlocked, reducedMotion, netStatus,
  } = props;
  const self = match.self as MatchSnapshot["self"];
  const minutes = Math.floor(match.secondsLeft / 60);
  const seconds = String(match.secondsLeft % 60).padStart(2, "0");
  const hasTarget = Boolean(targets.atGate || targets.drop || targets.furniture);
  const primaryLabel = targets.atGate ? "Escape" : targets.drop ? "Pick up" : targets.furniture ? "Search" : "Walk closer";
  const trapTotal = TRAP_TYPES.reduce((total, type) => total + (self.traps[type] ?? 0), 0);
  const down = self.respawnMs > 0;
  const canTrap = Boolean(targets.furniture) && !targets.furniture?.trap && trapTotal > 0;

  return <div className="er-match">
    <div className="er-hud-top">
      {netStatus !== "online" && <span className={`er-dot er-dot-${netStatus}`} title="Relay connection" />}
      <span className="er-room">{match.roomName}</span>
      <span className={`er-timer${match.secondsLeft <= 30 ? " er-timer-low" : ""}`}>{minutes}:{seconds}</span>
      <div className="er-items">
        {MISSION_ITEMS.map(item => <span key={item}
          className={`er-item${self.inventory.includes(item) ? " er-item-on" : ""}`}
          title={MISSION_ITEM_LABELS[item]}>{MISSION_ITEM_LABELS[item].charAt(0)}</span>)}
      </div>
      <button type="button" className="er-icon" onClick={onSettings} aria-label="Settings">≡</button>
    </div>

    <div className="er-stage">
      <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} className="er-canvas" tabIndex={0}
        onPointerDown={event => { event.currentTarget.focus({ preventScroll: true }); onCanvasPointer(event); }}
        aria-label={`Embassy room ${match.roomName}. Move with WASD, arrow keys or the on-screen stick. E searches, F strikes, Q sets a trap.`} />

      {down && <div className="er-down" role="status">
        <strong>Taken out</strong>
        <span>Back in {Math.ceil(self.respawnMs / 1000)}s</span>
      </div>}

      <ul className="er-feed" aria-live="polite">
        {feed.map((event: MatchEvent, index: number) =>
          <li key={`${event.at}-${index}`} className={`er-feed-${event.tone}`}>{event.text}</li>)}
      </ul>

      <aside className="er-scores">
        {match.scoreboard.map((player: PublicPlayer) => <div key={player.playerId}
          className={player.playerId === self.playerId ? "er-me" : ""}>
          <span>{player.codename}{player.genesis ? " ◆" : ""}</span>
          <span>{player.items}/4{player.connected ? "" : " ·off"}</span>
        </div>)}
      </aside>

      <Stick stickRef={stickRef} disabled={inputBlocked || down} reducedMotion={reducedMotion} />

      <div className="er-rotate">Turn your phone sideways for a full-size embassy</div>

      <div className="er-actions">
        <button type="button" className="er-action er-action-primary" disabled={inputBlocked || down || !hasTarget}
          onClick={onPrimary}>{primaryLabel}<small>E</small></button>
        <button type="button" className="er-action" disabled={inputBlocked || down || !canTrap}
          onClick={onTraps}>Trap<small>{trapTotal} · Q</small></button>
        <button type="button" className="er-action" disabled={inputBlocked || down}
          onClick={onAttack}>Strike<small>F</small></button>
        {self.hasDisarm && <button type="button" className="er-action"
          disabled={inputBlocked || down || !targets.furniture?.trap || targets.furniture?.trapMine}
          onClick={onDisarm}>Disarm</button>}
      </div>
    </div>
  </div>;
}

function Stick({ stickRef, disabled, reducedMotion }: any) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);

  const update = (event: React.PointerEvent) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = (event.clientX - cx) / radius;
    let dy = (event.clientY - cy) / radius;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude > 1) { dx /= magnitude; dy /= magnitude; }
    stickRef.current = { dx, dy, active: true };
    setKnob({ x: dx * radius * 0.6, y: dy * radius * 0.6 });
  };

  const release = () => {
    stickRef.current = { dx: 0, dy: 0, active: false };
    pointerRef.current = null;
    setKnob({ x: 0, y: 0 });
  };

  useEffect(() => { if (disabled) release(); }, [disabled]);

  return <div ref={baseRef} className={`er-stick${disabled ? " er-stick-off" : ""}`}
    onPointerDown={event => {
      if (disabled) return;
      pointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      update(event);
    }}
    onPointerMove={event => { if (!disabled && pointerRef.current === event.pointerId) update(event); }}
    onPointerUp={release}
    onPointerCancel={release}
    aria-hidden="true">
    <div className="er-stick-knob" style={{
      transform: `translate(${knob.x}px, ${knob.y}px)`,
      transition: reducedMotion ? "none" : "transform 60ms linear",
    }} />
  </div>;
}

function ResultsScreen({ results, identity, onBack, onAgain, inLobby }: any) {
  const won = results.results.find((player: PublicPlayer) => player.playerId === identity?.playerId);
  return <div className="er-results">
    <div className="er-panel">
      <h2>{results.winnerName ? `${results.winnerName} wins` : "No winner"}</h2>
      <p>{results.reason}</p>
      <ol className="er-result-list">
        {results.results.map((player: PublicPlayer, index: number) => <li key={player.playerId}
          className={player.playerId === identity?.playerId ? "er-me" : ""}>
          <span>{index + 1}. {player.codename}{player.genesis ? " ◆" : ""}</span>
          <span>{player.items}/4 recovered · {player.deaths} losses</span>
        </li>)}
      </ol>
      <p className="er-fine">
        Match results are recorded by the relay for this session only. No RF changed hands: kits are
        kept in your simulated FriendSDK inventory whether you win or lose.
      </p>
      <div className="er-row">
        {inLobby && <button type="button" className="er-primary" onClick={onAgain}>Back to the lobby</button>}
        <button type="button" onClick={onBack}>Leave lobby</button>
      </div>
    </div>
  </div>;
}
