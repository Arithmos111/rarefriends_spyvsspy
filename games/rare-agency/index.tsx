"use client";

/**
 * The Rare Agency — a four-player Spy vs Spy-style stealth match for FriendSDK v0.1.
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
// frame.css and runtime.css are injected into the child document by the SDK runner, and a
// game directory may not bundle anything from the SDK's assets/ folder.

import { createNet, type Net, type NetStatus } from "./net.ts";
import {
  LESSONS, TRAINEE, advanceTutorial, lessonOf, startTutorial, stepTutorial, tutorialAction,
  tutorialSnapshot, type Lesson, type TutorialState,
} from "./tutorial.ts";
import {
  drawAgentPortrait, drawCarryableGlyph, drawEmbassy, drawEscapeScene, drawHurtVignette,
  drawTitleScreen, doorAnchorWorld, ESCAPE_DURATION_MS, HURT_FLASH_MS, unproject,
  VIEW_H, VIEW_W, type ActiveEffect,
} from "./render.ts";
import { createAudio, type Audio, type SoundCue } from "./audio.ts";
import {
  DIRECTIONS, INPUT_MS, INTERACT_RANGE, MATCH_SECONDS, MAX_FRIEND_NAME, MISSION_ITEMS, TICK_MS,
  MISSION_ITEM_LABELS, POWER_UP_BLURBS, POWER_UP_LABELS, ROOM_H, ROOM_W, TRAP_LABELS,
  TRAP_TYPES, canonicalDoorTrapId, carryableLabel, displayName, isDoorTrapId,
  normaliseFriendName,
  type Carryable, type Direction, type LeaderboardRow, type LobbyMember, type LobbySummary,
  type MatchCue, type MatchEvent, type MatchSnapshot, type PowerUp, type PublicPlayer,
  type ServerMessage, type TrapType,
} from "./shared/protocol.ts";
import {
  EXIT_RADIUS, EXIT_X, EXIT_Y, blockedByFurniture, createMap, insideRoom,
  type EmbassyMap, type Room,
} from "./shared/mansion.ts";
import { KITS, FIELD_KIT_ID, kitById } from "./shared/loadouts.ts";
import { movePlayer, type Facing } from "./shared/sim.ts";
import "./style.css";

type Screen = "confirm" | "title" | "briefing" | "lobby" | "match" | "escape" | "results";
type Menu = "crate" | "kits" | "settings" | "join" | "create" | "reveal" | "traps"
  | "leaderboard" | "codename" | null;

/** A centre-screen flash when something is picked up or goes wrong. */
type Flash = { id: number; item: Carryable | null; title: string; detail: string; tone: "good" | "bad"; at: number };
const FLASH_MS = 1600;

const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/**
 * Tapping furniture means "go and use that", not "walk inside it". Find the closest spot the
 * agent can actually stand that still puts the destination within reach.
 */
function approachPoint(room: Room, target: { x: number; y: number }, from: { x: number; y: number }) {
  // Expand outward from the object and take the first ring with somewhere to stand, choosing
  // the spot nearest the agent. INTERACT_RANGE is set so this always lands within reach.
  for (let radius = 30; radius <= 96; radius += 6) {
    let best: { x: number; y: number } | null = null;
    let bestGap = Infinity;
    for (let step = 0; step < 24; step++) {
      const angle = (step / 24) * Math.PI * 2;
      const x = target.x + Math.cos(angle) * radius;
      const y = target.y + Math.sin(angle) * radius;
      if (!insideRoom(x, y) || blockedByFurniture(room, x, y)) continue;
      const gap = distance(x, y, from.x, from.y);
      if (gap < bestGap) { bestGap = gap; best = { x, y }; }
    }
    if (best) return best;
  }
  return null;
}

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
  const [results, setResults] = useState<{
    winnerName: string | null; reason: string; results: readonly PublicPlayer[];
    /** This agent's own career standing after the match, or null before the relay sends it. */
    career: { won: boolean; earned: number; points: number; place: number; of: number } | null;
  } | null>(null);
  const [feed, setFeed] = useState<readonly MatchEvent[]>([]);
  const [relayError, setRelayError] = useState("");

  // ---- Presentation ---------------------------------------------------------------------
  const [menu, setMenu] = useState<Menu>(null);
  const [equippedKit, setEquippedKit] = useState<string>(FIELD_KIT_ID);
  const [muted, setMuted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [lobbyName, setLobbyName] = useState("");
  const [privateLobby, setPrivateLobby] = useState(false);
  const [spriteTick, setSpriteTick] = useState(0);
  const [musicOn, setMusicOn] = useState(true);
  const [flashes, setFlashes] = useState<readonly Flash[]>([]);
  const [leaderboard, setLeaderboard] = useState<readonly LeaderboardRow[]>([]);
  const [friendName, setFriendName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [escape, setEscape] = useState<{ startedAt: number; won: boolean; codename: string; friendName: string | null } | null>(null);
  const [visitedRooms, setVisitedRooms] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [artworkFailed, setArtworkFailed] = useState(0);
  const [enteringMatch, setEnteringMatch] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const netRef = useRef<Net | null>(null);
  const soundRef = useRef<FriendSoundKit | null>(null);
  const audioRef = useRef<Audio | null>(null);
  const flashSeq = useRef(1);
  const spritesRef = useRef(new Map<string, any>());
  /** Effect id to the local timestamp its animation started at. */
  const effectStartsRef = useRef(new Map<number, number>());
  /** Screen shake left to spend, in pixels, and when the last blow landed on us. */
  const shakeRef = useRef(0);
  const hurtFlashRef = useRef(0);
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
  const screenRef = useRef<Screen>("title");
  /** Cleared the first time the agent leaves the attract screen, and never shown again. */
  const [atTitle, setAtTitle] = useState(true);
  /** Cleared once the player has seen and accepted which agent the SDK handed them. */
  const [confirmed, setConfirmed] = useState(false);
  /** The training run, when one is in progress. It replaces the relay entirely. */
  const [tutorial, setTutorial] = useState<TutorialState | null>(null);
  const tutorialRef = useRef<TutorialState | null>(null);
  tutorialRef.current = tutorial;
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [tutorialDone, setTutorialDone] = useState(false);
  /** Collapses the objective card so the room underneath can be experimented with. */
  const [lessonHidden, setLessonHidden] = useState(false);

  /** Leave the training run and hand the screen back to the briefing. */
  const endTutorial = useCallback(() => {
    tutorialRef.current = null;
    mapRef.current = null;
    setTutorial(null);
    setLesson(null);
    setTutorialDone(false);
    setMatch(null);
    matchRef.current = null;
  }, []);

  const beginTutorial = useCallback(() => {
    const state = startTutorial(0);
    setTutorialDone(false);
    setLesson(lessonOf(state));
    setTutorial(state);
    tutorialRef.current = state;
    // The renderer needs the map, which in a live match arrives with match.start. The
    // rehearsal has no relay, so take the map straight off the sim it is stepping.
    mapRef.current = state.sim.map;
    walkToRef.current = null;
    setVisitedRooms(new Set<number>());
    setResults(null);
    // Publish the opening view synchronously. The match screen owns the canvas the render
    // loop draws into, and the loop only runs on the match screen, so without a first
    // snapshot here neither would ever start.
    const view = tutorialSnapshot(state);
    matchRef.current = view;
    setMatch(view);
    setFeed([]);
  }, []);

  matchRef.current = match;
  pausedRef.current = paused;
  menuRef.current = menu;
  reducedRef.current = reducedMotion;

  const screen: Screen = escape ? "escape" : results ? "results" : match ? "match"
    : lobby ? "lobby" : !confirmed ? "confirm" : atTitle ? "title" : "briefing";
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
    // Audio ships on. Browsers keep the context suspended until a gesture, and the first
    // screen needs a click to get past it, so nothing sounds before the player has acted.
    soundRef.current = createFriendSoundKit({ muted: mutedRef.current });
    audioRef.current = createAudio();
    audioRef.current.setMuted(mutedRef.current);
    audioRef.current.setMusic(musicRef.current);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(preference.matches);
    sync();
    preference.addEventListener("change", sync);
    void refreshEconomy();
    return () => {
      preference.removeEventListener("change", sync);
      soundRef.current?.dispose();
      soundRef.current = null;
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, [refreshEconomy]);

  /** Music runs from the title screen through to the results, and stops when either toggle is off. */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!muted && musicOn) audio.startMusic();
    else audio.stopMusic();
  }, [muted, musicOn]);

  // These choices last the session only. The game runs in an allow-scripts sandbox, whose
  // opaque origin makes localStorage throw on access, so there is nowhere to persist them.
  const mutedRef = useRef(muted);
  const musicRef = useRef(musicOn);
  mutedRef.current = muted;
  musicRef.current = musicOn;

  const pushFlash = useCallback((flash: Omit<Flash, "id" | "at">) => {
    const entry: Flash = { ...flash, id: flashSeq.current++, at: Date.now() };
    setFlashes(current => [...current, entry].slice(-3));
    setTimeout(() => setFlashes(current => current.filter(item => item.id !== entry.id)), FLASH_MS);
  }, []);

  /** Turn a server cue into a sound and, where it matters, a centre-screen flash. */
  const handleCue = useCallback((value: MatchCue) => {
    const audio = audioRef.current;
    const play = (sound: SoundCue) => audio?.play(sound);
    switch (value.kind) {
      case "pickup": {
        const major = MISSION_ITEMS.includes(value.item as never) || value.item === "knife";
        play(major ? "pickup-major" : "pickup");
        pushFlash({
          item: value.item,
          title: carryableLabel(value.item),
          detail: MISSION_ITEMS.includes(value.item as never)
            ? "Intelligence secured"
            : POWER_UP_BLURBS[value.item as PowerUp],
          tone: "good",
        });
        break;
      }
      case "trap":
        play(`trap-${value.trap}` as SoundCue);
        pushFlash({ item: null, title: TRAP_LABELS[value.trap], detail: "You set it off", tone: "bad" });
        break;
      case "trap-sprung":
        play("trap-sprung");
        pushFlash({
          item: null, title: `Your ${TRAP_LABELS[value.trap].toLowerCase()} fired`,
          detail: "Somebody walked into it", tone: "good",
        });
        break;
      case "hurt":
        play(value.amount >= 2 ? "hurt-heavy" : "hurt");
        // A jolt and a red edge, scaled by the blow. Reduced motion keeps the vignette and
        // drops the shake, since the shake is the part that causes trouble.
        shakeRef.current = Math.max(shakeRef.current, reducedRef.current ? 0 : value.amount >= 2 ? 13 : 8);
        hurtFlashRef.current = performance.now();
        break;
      case "hit": play(value.amount >= 2 ? "hit-heavy" : "hit"); break;
      case "heal": play("heal"); break;
      case "takedown": play("takedown"); break;
      case "downed":
        play("downed");
        pushFlash({ item: null, title: "Taken out", detail: "You dropped everything", tone: "bad" });
        break;
    }
  }, [pushFlash]);

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
        setFriendName(message.friendName);
        setNameDraft(message.friendName ?? "");
        setRelayError("");
        break;
      case "leaderboard":
        setLeaderboard(message.rows);
        break;
      case "friend.name":
        setFriendName(message.friendName);
        setNameDraft(message.friendName ?? "");
        setNotice(message.friendName ? `Your Friend is now known as ${message.friendName}.` : "Name cleared.");
        break;
      case "cues":
        for (const value of message.cues) handleCue(value);
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
        setEnteringMatch(false);
        break;
      case "match.start": {
        mapRef.current = createMap(message.seed);
        walkToRef.current = null;
        setEnteringMatch(true);
        setVisitedRooms(new Set<number>());
        setResults(null);
        setFeed([]);
        seqRef.current = 1;
        break;
      }
      case "snapshot": {
        const previous = matchRef.current;
        setMatch(message);
        setEnteringMatch(false);
        if (previous?.roomIndex !== message.roomIndex) {
          setVisitedRooms(current => current.has(message.roomIndex)
            ? current
            : new Set(current).add(message.roomIndex));
          audioRef.current?.play("door");
        }
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
      case "match.end": {
        const mine = message.winner && message.winner === identityRef.current?.playerId;
        setResults({
          winnerName: message.winnerName, reason: message.reason, results: message.results,
          career: message.career ?? null,
        });
        setMatch(null);
        setEnteringMatch(false);
        netRef.current?.send({ t: "leaderboard" });
        // Reaching the gate earns the departure sequence; a timeout goes straight to results.
        if (message.escaped) {
          const winner = message.results.find(entry => entry.playerId === message.winner);
          setEscape({
            startedAt: performance.now(),
            won: Boolean(mine),
            codename: message.winnerName ?? "The agent",
            friendName: winner?.friendName ?? null,
          });
          audioRef.current?.play("escape");
        } else {
          audioRef.current?.play(mine ? "escape" : "lose");
        }
        soundRef.current?.play(mine ? "reward" : "reveal-common");
        break;
      }
      case "error":
        setRelayError(message.message);
        break;
    }
  }, [handleCue]);

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

  // ---- Friend artwork -------------------------------------------------------------------
  // Loading is driven from the render loop rather than an effect keyed on the snapshot: a
  // snapshot arrives 20 times a second, and an effect cleanup on every one of those would
  // cancel each artwork read long before it resolved, leaving every Friend a placeholder.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);

  const countArtworkFailures = () =>
    [...spritesRef.current.values()].filter(entry => entry === "error").length;

  const ensureSprites = useCallback((ids: readonly string[]) => {
    const reader = (readerRef.current ??= createFriendReader());
    for (const id of ids) {
      if (spritesRef.current.has(id)) continue;
      spritesRef.current.set(id, "loading");
      reader.read(BigInt(id))
        .then(sprites => {
          if (unmountedRef.current) return;
          spritesRef.current.set(id, sprites);
          setSpriteTick(value => value + 1);
        })
        .catch(() => {
          if (unmountedRef.current) return;
          spritesRef.current.set(id, "error");
          setSpriteTick(value => value + 1);
          setArtworkFailed(countArtworkFailures());
        });
    }
  }, []);

  // The title screen shows this Friend at portrait scale, so start the read on mount rather
  // than waiting for the first match snapshot to ask for it.
  useEffect(() => { ensureSprites([String(friendId)]); }, [ensureSprites, friendId]);

  /** Drop failed artwork so the render loop re-requests it. */
  const retryArtwork = useCallback(() => {
    for (const [id, entry] of [...spritesRef.current.entries()]) {
      if (entry === "error") spritesRef.current.delete(id);
    }
    readerRef.current?.clear();
    setArtworkFailed(0);
    setSpriteTick(value => value + 1);
  }, []);

  // ---- Interaction targets --------------------------------------------------------------
  type Targets = {
    furniture: MatchSnapshot["furniture"][number] | null;
    drop: MatchSnapshot["drops"][number] | null;
    atGate: boolean;
    /** Nearest furniture regardless of reach, used for the walk-to hint and checks. */
    nearest: MatchSnapshot["furniture"][number] | null;
    /** Doorway within reach, which can be trapped just like furniture. */
    door: Direction | null;
    /** The trap on whatever is currently in reach, if the viewer can see it. */
    trapHere: MatchSnapshot["traps"][number] | null;
  };
  const emptyTargets: Targets = { furniture: null, drop: null, atGate: false, nearest: null, door: null, trapHere: null };
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
    // A doorway is trappable from inside its own room, like a piece of furniture.
    let door: Direction | null = null;
    let doorGap = INTERACT_RANGE;
    for (const direction of snapshot.doors) {
      const anchor = doorAnchorWorld(direction);
      const gap = distance(x, y, anchor.x, anchor.y);
      if (gap <= doorGap) { doorGap = gap; door = direction; }
    }

    const furniture = nearestGap <= INTERACT_RANGE ? nearest : null;
    // Prefer whichever of the two is actually closer, so a doorway beside a cabinet is not
    // permanently shadowed by it.
    const preferDoor = door !== null && doorGap < nearestGap;
    const targetId = preferDoor && door
      ? canonicalDoorTrapId(snapshot.roomIndex, door)
      : furniture?.id ?? null;
    return {
      furniture: preferDoor ? null : furniture,
      drop,
      atGate: snapshot.exitHere && distance(x, y, EXIT_X, EXIT_Y) <= EXIT_RADIUS,
      nearest,
      door: preferDoor ? door : null,
      trapHere: targetId === null ? null : snapshot.traps.find(entry => entry.targetId === targetId) ?? null,
    };
  }, []);

  // ---- Input ----------------------------------------------------------------------------
  const sendAction = useCallback((action: Parameters<Net["send"]>[0] extends never ? never : any) => {
    // The training run resolves actions locally; nothing about it touches the relay.
    if (tutorialRef.current) { tutorialAction(tutorialRef.current, action); return; }
    netRef.current?.send({ t: "action", seq: seqRef.current++, action });
  }, []);

  /**
   * Swinging is predicted locally for its sound: waiting for the server to confirm the blow
   * would put the swish a round trip behind the animation. Whether it connects is still the
   * server's call, and arrives as a hurt/takedown cue.
   */
  const swing = useCallback(() => {
    audioRef.current?.play(matchRef.current?.self.hasKnife ? "knife" : "search");
    sendAction({ kind: "attack" });
  }, [sendAction]);

  const primaryAction = useCallback(() => {
    const current = targetsRef.current;
    if (current.atGate) return sendAction({ kind: "escape" });
    if (current.drop) return sendAction({ kind: "pickup", dropId: current.drop.id });
    if (current.furniture) return sendAction({ kind: "search", furnitureId: current.furniture.id });
  }, [sendAction]);

  const plantTrap = useCallback((trap: TrapType) => {
    const current = targetsRef.current;
    const snapshot = matchRef.current;
    const targetId = current.door && snapshot
      ? canonicalDoorTrapId(snapshot.roomIndex, current.door)
      : current.furniture?.id ?? null;
    if (targetId === null) return;
    sendAction({ kind: "plant", targetId, trap });
    audioRef.current?.play("plant");
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
      else if (key === "f") { event.preventDefault(); swing(); }
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
  }, [primaryAction, swing, plantTrap]);

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
      if (screenRef.current !== "match" || tutorialRef.current) return;
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
    let stalledMs = 0;
    let lastX = 0, lastY = 0;
    let publishDue = 0;

    const loop = (nowMs: number) => {
      const delta = Math.min(50, nowMs - previous);
      previous = nowMs;

      // The training run has no relay: it steps its own sim here and publishes the same
      // snapshot shape the server would have sent, so everything downstream is unchanged.
      const rehearsal = tutorialRef.current;
      if (rehearsal) {
        const blocked = pausedRef.current || menuRef.current !== null;
        const [dx, dy] = blocked ? [0, 0] : inputVector();
        stepTutorial(rehearsal, delta, dx, dy);
        // Drain the sim's own cues and events, exactly as the relay would have relayed them,
        // so the rehearsal has the same sounds, flashes and log as a live match.
        if (rehearsal.sim.cues.length) {
          for (const entry of rehearsal.sim.cues) {
            if (entry.to === TRAINEE) handleCue(entry);
          }
          rehearsal.sim.cues.length = 0;
        }
        if (rehearsal.sim.events.length) {
          const mine = rehearsal.sim.events.filter(entry => !entry.to || entry.to === TRAINEE);
          rehearsal.sim.events.length = 0;
          if (mine.length) setFeed(current => [...current, ...mine].slice(-6));
        }

        const view = tutorialSnapshot(rehearsal);
        matchRef.current = view;
        // Publishing at the relay's tick rate rather than the display rate keeps the HUD
        // re-rendering exactly as often as it does in a real match.
        publishDue -= delta;
        if (publishDue <= 0) {
          publishDue = TICK_MS;
          setMatch(view);
          setLesson(lessonOf(rehearsal));
          setTutorialDone(rehearsal.finished);
        }
        // Locally authoritative, so there is nothing to predict: take the sim's own position.
        const agent = rehearsal.sim.players.get(TRAINEE)!;
        predictedRef.current = {
          room: agent.room, x: agent.x, y: agent.y,
          facing: agent.facing, walking: agent.walking,
        };
      }

      const snapshot = matchRef.current;
      const embassy = mapRef.current;
      if (snapshot && embassy) {
        const self = snapshot.self;
        ensureSprites([self.friendId, ...snapshot.actors.map(actor => actor.friendId)]);
        const canMove = !rehearsal && !self.busy && self.stunnedMs <= 0
          && self.respawnMs <= 0 && !pausedRef.current;
        if (canMove) {
          const [dx, dy] = inputVector();
          movePlayer(embassy, predictedRef.current, dx, dy, delta);
        } else {
          predictedRef.current.walking = false;
        }

        // Tap-to-walk steers in a straight line with no pathfinding, so a destination behind
        // furniture can leave the agent pressing into a corner. Give the target up instead.
        if (walkToRef.current) {
          const moved = Math.hypot(predictedRef.current.x - lastX, predictedRef.current.y - lastY);
          stalledMs = moved < 0.4 ? stalledMs + delta : 0;
          if (stalledMs > 1200) { walkToRef.current = null; stalledMs = 0; }
        } else {
          stalledMs = 0;
        }
        lastX = predictedRef.current.x;
        lastY = predictedRef.current.y;

        const next = computeTargets(snapshot);
        const previousTargets = targetsRef.current;
        targetsRef.current = next;
        if (previousTargets.furniture?.id !== next.furniture?.id
          || previousTargets.drop?.id !== next.drop?.id
          || previousTargets.atGate !== next.atGate
          || previousTargets.nearest?.id !== next.nearest?.id
          || previousTargets.door !== next.door
          || previousTargets.trapHere?.type !== next.trapHere?.type
          || previousTargets.trapHere?.mine !== next.trapHere?.mine) {
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

        // Effects arrive with the age they had when the snapshot was built. Anchor each id to a
        // local start time the first time it is seen, so the animation runs at display rate
        // rather than stepping once per snapshot, and drop anchors once an effect is gone.
        const starts = effectStartsRef.current;
        const live: ActiveEffect[] = [];
        const seen = new Set<number>();
        for (const entry of snapshot.effects) {
          seen.add(entry.id);
          let startedAt = starts.get(entry.id);
          if (startedAt === undefined) {
            startedAt = nowMs - entry.ageMs;
            starts.set(entry.id, startedAt);
          }
          live.push({ kind: entry.kind, x: entry.x, y: entry.y, elapsedMs: nowMs - startedAt });
        }
        for (const id of starts.keys()) if (!seen.has(id)) starts.delete(id);

        // Shake decays quickly, and is applied to the world only: the HUD is drawn in CSS
        // above the canvas, so it stays put while the room lurches.
        const shake = shakeRef.current;
        if (shake > 0.2) {
          shakeRef.current = shake * Math.pow(0.001, delta / 1000);
          context.save();
          context.translate(
            (Math.random() * 2 - 1) * shake,
            (Math.random() * 2 - 1) * shake * 0.6,
          );
        } else {
          shakeRef.current = 0;
        }

        drawEmbassy(context, {
          snapshot,
          selfX: predictedRef.current.x,
          selfY: predictedRef.current.y,
          sprites: spritesRef.current,
          decor: embassy.rooms[snapshot.roomIndex]?.decor ?? [],
          nearestFurnitureId: targetsRef.current.furniture?.id ?? null,
          nearestDropId: targetsRef.current.drop?.id ?? null,
          nearestDoor: targetsRef.current.door,
          effects: live,
          reducedMotion: reducedRef.current,
          timeMs: nowMs,
        });
        if (shake > 0.2) context.restore();

        // A red vignette over everything, fading over HURT_FLASH_MS.
        const sinceHurt = nowMs - hurtFlashRef.current;
        if (hurtFlashRef.current > 0 && sinceHurt < HURT_FLASH_MS) {
          drawHurtVignette(context, 1 - sinceHurt / HURT_FLASH_MS);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [screen, inputVector, computeTargets, ensureSprites, handleCue]);

  const onCanvasPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (inputBlocked || !matchRef.current) return;
    // Map the pointer through the same letterbox the browser would apply, so the hit test
    // stays correct even if the element box is not exactly 3:2.
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
    if (!(scale > 0)) return;
    const insetX = (rect.width - VIEW_W * scale) / 2;
    const insetY = (rect.height - VIEW_H * scale) / 2;
    const sx = (event.clientX - rect.left - insetX) / scale;
    const sy = (event.clientY - rect.top - insetY) / scale;
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
    let destination = {
      x: Math.max(0, Math.min(ROOM_W, wx)),
      y: Math.max(0, Math.min(ROOM_H, wy)),
    };
    const room = mapRef.current?.rooms[snapshot.roomIndex];
    if (room && (!insideRoom(destination.x, destination.y) || blockedByFurniture(room, destination.x, destination.y))) {
      destination = approachPoint(room, destination, me) ?? destination;
    }
    walkToRef.current = { ...destination, room: snapshot.roomIndex };
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
      <h1>The Rare Agency</h1>
      <p>{economyError}</p>
      <button type="button" className="er-primary" disabled={busy || paused} onClick={() => void refreshEconomy()}>Retry</button>
    </section>;
  }
  if (!economy) {
    return <section className="er-shell er-center" role="status">
      <h1>The Rare Agency</h1>
      <p>Opening the diplomatic pouch…</p>
    </section>;
  }
  if (economy.friendId !== friendId) {
    return <section className="er-shell er-center" role="alert">
      <h1>The Rare Agency</h1>
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
        <strong>THE RARE AGENCY</strong>
        <span className="er-sim">Simulated RF</span>
      </div>
      <div className="er-status">
        <span className={`er-dot er-dot-${netStatus}`} aria-hidden="true" />
        <span>{statusLine}</span>
        {/* Audio ships on, so the way to turn it off has to be reachable from every screen,
            not only from inside a match. */}
        {/* No aria-label: the visible text is the accessible name, and aria-pressed
            carries the state. An aria-label here would override the text people read. */}
        <button type="button" className="er-quiet" aria-pressed={!muted}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            soundRef.current?.setMuted(next);
            audioRef.current?.setMuted(next);
            if (!next) { void soundRef.current?.unlock(); void audioRef.current?.unlock(); }
          }}>{muted ? "Sound off" : "Sound on"}</button>
        <button type="button" className="er-quiet"
          onClick={() => setMenu("settings")} aria-label="Open settings">Settings</button>
      </div>
    </header>}

    {relayError && <p className="er-banner" role="alert">{relayError}</p>}

    {screen === "confirm" && <ConfirmScreen
      sprites={spritesRef.current} reducedMotion={reducedMotion} friendId={friendId}
      codename={identity?.codename ?? "AGENT"} friendName={friendName}
      genesis={Boolean(identity?.genesis)} career={careerOf(leaderboard, friendId)}
      onConfirm={() => { void audioRef.current?.unlock(); setConfirmed(true); }}
    />}

    {screen === "title" && <TitleScreen
      sprites={spritesRef.current} reducedMotion={reducedMotion} friendId={friendId}
      codename={identity?.codename ?? "AGENT"} friendName={friendName}
      career={careerOf(leaderboard, friendId)} netStatus={netStatus}
      onStart={() => { void audioRef.current?.unlock(); setAtTitle(false); }}
      onTutorial={() => { void audioRef.current?.unlock(); setAtTitle(false); beginTutorial(); }}
      onStandings={() => setMenu("leaderboard")}
    />}

    {screen === "briefing" && <BriefingScreen
      economy={economy} definition={definition} rf={rf} crateCount={crateCount} canBuy={canBuy}
      maxPrize={maxPrize} busy={busy} paused={paused} notice={notice}
      identity={identity} friendId={friendId} equippedKit={equippedKit}
      ownedKits={ownedKits} lobbies={lobbies} netStatus={netStatus}
      friendName={friendName} leaderboard={leaderboard}
      onBuy={() => void act(() => client.buy(1n), "purchase", "One simulated Gadget Crate added.")}
      onOpen={() => void openCrate()}
      onSetMenu={setMenu} onQuick={quickMatch} onJoin={joinLobby}
      onTutorial={() => { void audioRef.current?.unlock(); beginTutorial(); }}
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
      onAttack={swing}
      onTraps={() => setMenu("traps")}
      onDisarm={() => {
        const targetId = targets.trapHere?.targetId;
        if (targetId !== undefined) sendAction({ kind: "disarm", targetId });
      }}
      lesson={lesson} lessonIndex={tutorial?.index ?? 0} lessonCount={LESSONS.length}
      tutorialDone={tutorialDone} lessonHidden={lessonHidden}
      onHideLesson={() => setLessonHidden(true)}
      onShowLesson={() => setLessonHidden(false)}
      onSkipLesson={() => { if (tutorialRef.current) advanceTutorial(tutorialRef.current); }}
      onLeaveTutorial={endTutorial}
      onSettings={() => setMenu("settings")}
      stickRef={stickRef} inputBlocked={inputBlocked} reducedMotion={reducedMotion}
      netStatus={netStatus} artworkFailed={artworkFailed} onRetryArtwork={retryArtwork}
      flashes={flashes} visitedRooms={visitedRooms} exitRoom={mapRef.current?.exitRoom ?? 4}
    />}

    {screen === "escape" && escape && <EscapeScreen
      escape={escape} sprites={spritesRef.current} reducedMotion={reducedMotion}
      friendId={friendId} onDone={() => setEscape(null)}
    />}

    {screen === "results" && results && <ResultsScreen
      results={results} identity={identity} onBack={leaveLobby}
      onAgain={() => { setResults(null); }} inLobby={Boolean(lobby)}
    />}

    {menu && <GameMenu
      title={menu === "crate" ? "Gadget crate" : menu === "kits" ? "Your kits" : menu === "settings" ? "Settings"
        : menu === "join" ? "Join by code" : menu === "create" ? "Create a lobby"
        : menu === "reveal" ? "Crate opened" : menu === "leaderboard" ? "Career standings"
        : menu === "codename" ? "Name your Friend" : "Set a trap"}
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
        {!match ? <p>Traps can only be set during a match.</p>
          : !targets.furniture && !targets.door
            ? <p>Stand beside a piece of furniture or a doorway to set a trap.</p>
            : <>
              <p>
                {targets.door
                  ? `Rig the ${targets.door} doorway. It springs on the next agent through it.`
                  : `Set a trap inside the ${targets.furniture!.type}. It springs on whoever searches it.`}
              </p>
              <p className="er-fine">
                Your own traps are live against you as well, so remember where you left them.
                A disarm tool recovers any trap, including your own.
              </p>
              <div className="er-trapgrid">
                {TRAP_TYPES.map((type, index) => {
                  const count = match.self.traps[type] ?? 0;
                  return <button key={type} type="button" className="er-trapbutton"
                    disabled={count <= 0 || Boolean(targets.trapHere)}
                    onClick={() => plantTrap(type)}>
                    <strong>{TRAP_LABELS[type]}</strong>
                    <span>{count} left · key {index + 1}</span>
                  </button>;
                })}
              </div>
              {targets.trapHere && <p className="er-fine">
                {targets.trapHere.mine ? "You already trapped this." : "This already holds a trap."}
              </p>}
            </>}
      </div>}

      {menu === "leaderboard" && <div className="er-menu">
        <p className="er-fine">
          Totals across every match this relay has hosted, kept per Rare Friend and preserved
          across restarts. 100 points for escaping with the full set, 40 for leading on time,
          10 per item recovered, 5 per takedown, 5 for surviving to the end.
        </p>
        {leaderboard.length === 0
          ? <p className="er-empty">No matches recorded yet. Be the first.</p>
          : <ol className="er-board">
            {leaderboard.map((row: LeaderboardRow, index: number) => <li key={row.friendId}
              className={row.friendId === friendId.toString() ? "er-me" : ""}>
              <span className="er-board-rank">{index + 1}</span>
              <span className="er-board-name">
                <strong>{displayName(row.codename, row.friendName)}</strong>
                <small>Friend #{row.friendId}</small>
              </span>
              <span className="er-board-stats">
                <strong>{row.points}</strong>
                <small>{row.wins}W · {row.escapes} escapes · {row.items} items · {row.takedowns} takedowns · {row.matches} played</small>
              </span>
            </li>)}
          </ol>}
      </div>}

      {menu === "codename" && <div className="er-menu">
        <p>
          Give Friend #{friendId.toString()} a name. It shows in parentheses after your codename
          everywhere, and travels with the Friend rather than with you.
        </p>
        <label className="er-field">Friend name
          <input value={nameDraft} maxLength={MAX_FRIEND_NAME} placeholder="Nightjar"
            onChange={event => setNameDraft(event.target.value)} />
        </label>
        <p className="er-fine">
          Letters, digits, spaces, apostrophes and hyphens, up to {MAX_FRIEND_NAME} characters.
          Preview: <strong>{displayName(identity?.codename ?? "AGENT", normaliseFriendName(nameDraft))}</strong>
        </p>
        <div className="er-row">
          <button type="button" className="er-primary"
            disabled={netStatus !== "online" || (nameDraft.trim().length > 0 && !normaliseFriendName(nameDraft))}
            onClick={() => { send({ t: "friend.name", name: nameDraft }); setMenu(null); }}>
            {nameDraft.trim() ? "Save name" : "Clear name"}
          </button>
          {friendName && <button type="button" onClick={() => { setNameDraft(""); send({ t: "friend.name", name: "" }); }}>
            Remove
          </button>}
        </div>
        <p className="er-fine">
          The relay cannot verify that a connected player controls the Friend they claim, since
          the sandboxed game frame has no signer. Names and standings are as trustworthy as that
          claim, which is recorded as a capability gap in the submission.
        </p>
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
        <div className="er-row">
          <button type="button" aria-pressed={!muted} onClick={() => {
            const next = !muted;
            setMuted(next);
            soundRef.current?.setMuted(next);
            audioRef.current?.setMuted(next);
            if (!next) { void soundRef.current?.unlock(); void audioRef.current?.unlock(); }
          }}>{muted ? "Sound off" : "Sound on"}</button>
          <button type="button" aria-pressed={musicOn} disabled={muted} onClick={() => {
            const next = !musicOn;
            setMusicOn(next);
            audioRef.current?.setMusic(next);
          }}>{musicOn ? "Music on" : "Music off"}</button>
        </div>
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

/**
 * A nine-cell plan of the embassy. Shows where you are, which rooms you have already been
 * through, and where the courtyard gate is, which is otherwise easy to lose track of.
 */
function Minimap({ roomIndex, exitRoom, visited }: { roomIndex: number; exitRoom: number; visited: ReadonlySet<number> }) {
  return <div className="er-minimap" role="img"
    aria-label={`Embassy plan. You are in room ${roomIndex + 1} of 9. The gate is room ${exitRoom + 1}.`}>
    {Array.from({ length: 9 }, (_, index) => {
      const classes = ["er-cell"];
      if (visited.has(index)) classes.push("er-cell-seen");
      if (index === exitRoom) classes.push("er-cell-gate");
      if (index === roomIndex) classes.push("er-cell-here");
      return <span key={index} className={classes.join(" ")}>{index === exitRoom ? "▣" : ""}</span>;
    })}
  </div>;
}

/** Renders one item glyph with the same code the world view uses, so the two never drift. */
function Glyph({ item, size = 22, dim = false }: { item: Carryable; size?: number; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = size * scale;
    canvas.height = size * scale;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, size, size);
    drawCarryableGlyph(context, size / 2, size / 2, size * 0.92, item, dim ? "#8d9678" : "#14180f");
  }, [item, size, dim]);
  return <canvas ref={ref} className="er-glyph" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** The four mission items, showing at a glance which are held and which are still out there. */
function MissionTrack({ inventory }: { inventory: readonly string[] }) {
  return <div className="er-track" role="group" aria-label="Mission items">
    {MISSION_ITEMS.map(item => {
      const held = inventory.includes(item);
      return <span key={item} className={`er-track-slot${held ? " er-track-held" : ""}`}
        title={`${MISSION_ITEM_LABELS[item]}${held ? " — secured" : " — still missing"}`}>
        <Glyph item={item} size={20} dim={!held} />
        <small>{held ? "✓" : "—"}</small>
      </span>;
    })}
    <span className="er-track-count">{inventory.length}/{MISSION_ITEMS.length}</span>
  </div>;
}

function BriefingScreen(props: any) {
  const {
    economy, definition, rf, crateCount, canBuy, maxPrize, busy, paused, notice, identity,
    friendId, equippedKit, ownedKits, lobbies, netStatus, onBuy, onOpen, onSetMenu, onQuick,
    onJoin, pendingPlay, friendName, leaderboard, onTutorial,
  } = props;
  const kit = kitById(equippedKit);
  return <div className="er-briefing">
    <div className="er-panel er-dossier">
      <h2>Agent dossier</h2>
      <dl>
        <div><dt>Codename</dt><dd>{displayName(identity?.codename ?? "—", friendName)}{identity?.genesis && <span className="er-badge">GENESIS</span>}</dd></div>
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
        <button type="button" disabled={busy || paused} onClick={() => onSetMenu("codename")}>
          {friendName ? "Rename" : "Name Friend"}
        </button>
        <button type="button" disabled={busy || paused} onClick={() => onSetMenu("leaderboard")}>
          Standings{leaderboard?.length ? ` · ${leaderboard.length}` : ""}
        </button>
        <button type="button" disabled={busy || paused} onClick={onTutorial}>Training run</button>
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
            {displayName(member.codename, member.friendName)}
            {member.genesis && <span className="er-badge">GENESIS</span>}
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

/**
 * The training run's objective card. It sits over the match HUD rather than replacing it, so
 * every control being taught is visible and working while the lesson is on screen.
 */
function TrainingOverlay({ lesson, index, count, done, hidden, onHide, onShow, onSkip, onLeave }: any) {
  if (!done && hidden) {
    // Collapsed to a slim bar so the room is clear to experiment in. The objective is still
    // named, because a hidden card should never leave anyone wondering what they were doing.
    return <div className="er-lesson-bar">
      <span className="er-lesson-step">Step {index + 1}/{count}</span>
      <strong>{lesson.title}</strong>
      <button type="button" onClick={onShow}>Show</button>
      <button type="button" onClick={onSkip}>Next step</button>
    </div>;
  }
  if (done) {
    return <div className="er-lesson er-lesson-done" role="status">
      <h3>Training complete</h3>
      <p>
        That is the whole game: search the furniture, take the four items, trap what you leave
        behind, and get to the courtyard gate before anyone else does.
      </p>
      <div className="er-row">
        <button type="button" className="er-primary" onClick={onLeave}>Find a match</button>
      </div>
    </div>;
  }
  return <div className="er-lesson" role="status" aria-live="polite">
    <div className="er-lesson-head">
      <span className="er-lesson-step">Step {index + 1} of {count}</span>
      <h3>{lesson.title}</h3>
    </div>
    <p>{lesson.body}</p>
    <div className="er-row">
      <button type="button" className="er-primary" onClick={onHide}>Got it — let me try</button>
      <button type="button" onClick={onSkip}>Next step</button>
      <button type="button" onClick={onLeave}>Leave training</button>
    </div>
  </div>;
}

function MatchScreen(props: any) {
  const {
    match, feed, targets, canvasRef, onCanvasPointer, onPrimary, onAttack, onTraps,
    onDisarm, onSettings, stickRef, inputBlocked, reducedMotion, netStatus,
    artworkFailed, onRetryArtwork, flashes, visitedRooms, exitRoom,
    lesson, lessonIndex, lessonCount, tutorialDone, lessonHidden,
    onHideLesson, onShowLesson, onSkipLesson, onLeaveTutorial,
  } = props;
  const self = match.self as MatchSnapshot["self"];
  const minutes = Math.floor(match.secondsLeft / 60);
  const seconds = String(match.secondsLeft % 60).padStart(2, "0");
  const hasTarget = Boolean(targets.atGate || targets.drop || targets.furniture);
  const primaryLabel = targets.atGate ? "Escape" : targets.drop ? "Pick up" : targets.furniture ? "Search" : "Walk closer";
  const trapTotal = TRAP_TYPES.reduce((total, type) => total + (self.traps[type] ?? 0), 0);
  const down = self.respawnMs > 0;
  const canTrap = Boolean(targets.furniture || targets.door) && !targets.trapHere && trapTotal > 0;

  return <div className="er-match">
    {(lesson || tutorialDone) && <TrainingOverlay
      lesson={lesson} index={lessonIndex} count={lessonCount} done={tutorialDone}
      hidden={lessonHidden} onHide={onHideLesson} onShow={onShowLesson}
      onSkip={onSkipLesson} onLeave={onLeaveTutorial}
    />}
    <div className="er-hud-top">
      {/* A rehearsal has no relay, so its connection dot would always read as trouble. */}
      {netStatus !== "online" && !lesson && !tutorialDone
        && <span className={`er-dot er-dot-${netStatus}`} title="Relay connection" />}
      <span className="er-room">{match.roomName}</span>
      <span className={`er-timer${match.secondsLeft <= 30 ? " er-timer-low" : ""}`}>{minutes}:{seconds}</span>
      <Minimap roomIndex={match.roomIndex} exitRoom={exitRoom} visited={visitedRooms} />
      <MissionTrack inventory={self.inventory} />
      {(() => {
        // Colour by remaining fraction, so a full bar never reads as danger.
        const fraction = Math.max(0, Math.min(1, self.hp / Math.max(1, self.maxHp)));
        const state = fraction > 0.6 ? "ok" : fraction > 0.3 ? "low" : "critical";
        return <div className={`er-health er-health-${state}`} title={`${self.hp} of ${self.maxHp} health`}>
          <span className="er-health-bar">
            <span className="er-health-fill" style={{ width: `${fraction * 100}%` }} />
          </span>
          <small>{self.hp}/{self.maxHp}</small>
        </div>;
      })()}
      {self.powerUps.length > 0 && <div className="er-kitbadges">
        {[...new Set(self.powerUps)].map((item: PowerUp) => <span key={item} className="er-kitbadge"
          title={`${POWER_UP_LABELS[item]} — ${POWER_UP_BLURBS[item]}`}><Glyph item={item} size={16} /></span>)}
      </div>}
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

      {flashes.length > 0 && <div className="er-flashes" aria-live="polite">
        {flashes.map((flash: Flash) => <div key={flash.id} className={`er-flash er-flash-${flash.tone}`}>
          {flash.item && <Glyph item={flash.item} size={46} />}
          <strong>{flash.title}</strong>
          <span>{flash.detail}</span>
        </div>)}
      </div>}

      {artworkFailed > 0 && <div className="er-artwork-error" role="alert">
        <span>{artworkFailed === 1 ? "A Friend's artwork could not load." : `${artworkFailed} Friends' artwork could not load.`}</span>
        <button type="button" onClick={onRetryArtwork}>Retry artwork</button>
      </div>}

      <ul className="er-feed" aria-live="polite">
        {feed.map((event: MatchEvent, index: number) =>
          <li key={`${event.at}-${index}`} className={`er-feed-${event.tone}`}>{event.text}</li>)}
      </ul>

      <aside className="er-scores">
        {match.scoreboard.map((player: PublicPlayer) => <div key={player.playerId}
          className={player.playerId === self.playerId ? "er-me" : ""}>
          <span className="er-score-name">
            {displayName(player.codename, player.friendName)}{player.genesis ? " ◆" : ""}
            {player.hasKnife ? " ✚" : ""}
          </span>
          <span>{player.items}/4{player.connected ? "" : " ·off"}</span>
        </div>)}
      </aside>

      <Stick stickRef={stickRef} disabled={inputBlocked || down} reducedMotion={reducedMotion} />

      <div className="er-rotate">Turn your phone sideways for a full-size embassy</div>

      <div className="er-actions">
        <button type="button" className="er-action er-action-primary" disabled={inputBlocked || down || !hasTarget}
          onClick={onPrimary}>{primaryLabel}<small>E</small></button>
        <button type="button" className="er-action" disabled={inputBlocked || down || !canTrap}
          onClick={onTraps}>{targets.door ? "Trap door" : "Trap"}<small>{trapTotal} · Q</small></button>
        <button type="button" className="er-action" disabled={inputBlocked || down}
          onClick={onAttack}>Strike<small>F</small></button>
        {self.hasDisarm && <button type="button" className="er-action"
          disabled={inputBlocked || down || !targets.trapHere}
          onClick={onDisarm}>Disarm<small>{targets.trapHere?.mine ? "yours" : "rival"}</small></button>}
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

/**
 * The first thing anybody sees. It runs before a lobby exists and needs no relay, so it is
 * also what shows while the connection is still coming up.
 */
/**
 * Shown once, before the title screen, so a player sees the agent they just chose.
 *
 * The SDK's picker lists Friends as text only, and the game cannot change that: the picker is
 * trusted runtime code outside the sandbox, and the game is handed a verified Friend with no
 * channel back. What the game can do is confirm the choice straight afterwards, and say
 * exactly which control switches it.
 */
function ConfirmScreen({
  sprites, reducedMotion, friendId, codename, friendName, genesis, career, onConfirm,
}: any) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const tick = (nowMs: number) => {
      drawAgentPortrait(context, {
        timeMs: nowMs, reducedMotion, sprites: sprites.get(String(friendId)),
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sprites, reducedMotion, friendId]);

  return <div className="er-confirm">
    <canvas ref={ref} width={VIEW_W} height={VIEW_H} className="er-canvas"
      aria-label={`Your agent: ${codename}, Rare Friend number ${friendId}.`} />
    <div className="er-confirm-card">
      <p className="er-confirm-kicker">Your agent</p>
      <h2>
        {codename}{friendName ? ` (${friendName})` : ""}
        {genesis && <span className="er-badge">GENESIS</span>}
      </h2>
      <p className="er-confirm-id">Rare Friend #{String(friendId)}</p>
      {career
        ? <p className="er-fine">
          {career.matches} {career.matches === 1 ? "mission" : "missions"} on record ·{" "}
          {career.points} career points
        </p>
        : <p className="er-fine">No missions on record yet.</p>}
      <button type="button" className="er-primary" onClick={onConfirm}>Deploy this agent</button>
      <p className="er-fine er-confirm-swap">
        Wrong one? Use the <strong>Friend #{String(friendId)}</strong> button in the bar below
        the game to pick another.
      </p>
    </div>
  </div>;
}

/** This Friend's own row out of the career standings, if it has ever finished a match. */
function careerOf(
  rows: readonly LeaderboardRow[] | null, friendId: bigint,
): LeaderboardRow | null {
  return rows?.find(row => row.friendId === friendId.toString()) ?? null;
}

function TitleScreen({
  sprites, reducedMotion, friendId, codename, friendName, career,
  onStart, onTutorial, onStandings, netStatus,
}: any) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const tick = (nowMs: number) => {
      drawTitleScreen(context, {
        timeMs: nowMs, reducedMotion,
        sprites: sprites.get(String(friendId)),
        codename, friendName, friendId: String(friendId),
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sprites, reducedMotion, friendId, codename, friendName]);

  return <div className="er-title">
    <canvas ref={ref} width={VIEW_W} height={VIEW_H} className="er-canvas"
      aria-label={`The Rare Agency. Spy versus spy, run by Rare Friends. Playing as ${codename}, Rare Friend number ${friendId}.`} />
    <div className="er-title-actions">
      <button type="button" className="er-primary" onClick={onStart}>Enter the embassy</button>
      <button type="button" onClick={onTutorial}>Training run</button>
      <button type="button" onClick={onStandings}>Standings</button>
    </div>
    <p className="er-title-foot">
      <strong>{codename}{friendName ? ` (${friendName})` : ""}</strong>
      {" · "}Rare Friend #{String(friendId)}
      <br />
      {career
        ? `${career.matches} ${career.matches === 1 ? "mission" : "missions"} · ${career.points} career points · ${career.escapes} clean escapes`
        : "No missions on record yet. The training run explains everything in about a minute."}
      {netStatus !== "online" && " · connecting to the relay…"}
    </p>
  </div>;
}

function EscapeScreen({ escape, sprites, reducedMotion, friendId, onDone }: any) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [skippable, setSkippable] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) { onDone(); return; }
    let frame = 0;
    const started = escape.startedAt;
    const tick = (nowMs: number) => {
      const progress = (nowMs - started) / ESCAPE_DURATION_MS;
      drawEscapeScene(context, {
        progress, codename: escape.codename, friendName: escape.friendName,
        sprites: sprites.get(String(friendId)), reducedMotion, timeMs: nowMs, won: escape.won,
      });
      if (progress >= 1) { onDone(); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const allowSkip = setTimeout(() => setSkippable(true), 600);
    return () => { cancelAnimationFrame(frame); clearTimeout(allowSkip); };
  }, [escape, sprites, reducedMotion, friendId, onDone]);

  return <div className="er-escape">
    <canvas ref={ref} width={VIEW_W} height={VIEW_H} className="er-canvas"
      aria-label={escape.won ? "Your agent escapes to the airport" : "The winning agent escapes"} />
    {skippable && <button type="button" className="er-skip" onClick={onDone}>Skip</button>}
  </div>;
}

function ResultsScreen({ results, identity, onBack, onAgain, inLobby }: any) {
  const career = results.career as
    | { won: boolean; earned: number; points: number; place: number; of: number }
    | null;
  const ordinal = (value: number) => {
    const tens = value % 100;
    if (tens >= 11 && tens <= 13) return `${value}th`;
    return `${value}${["th", "st", "nd", "rd"][value % 10] ?? "th"}`;
  };
  return <div className="er-results">
    <div className="er-panel">
      {career && <div className={`er-verdict${career.won ? " er-verdict-won" : ""}`}>
        <strong>{career.won ? "YOU WON" : "YOU LOST"}</strong>
        <span>+{career.earned} career {career.earned === 1 ? "point" : "points"}</span>
      </div>}
      <h2>{results.winnerName ? `${results.winnerName} wins` : "No winner"}</h2>
      <p>{results.reason}</p>
      {career && <p className="er-standing">
        <strong>{ordinal(career.place)}</strong> on the career standings, out of {career.of}{" "}
        {career.of === 1 ? "agent" : "agents"} · <strong>{career.points}</strong>{" "}
        {career.points === 1 ? "point" : "points"} all told
      </p>}
      <ol className="er-result-list">
        {results.results.map((player: PublicPlayer, index: number) => <li key={player.playerId}
          className={player.playerId === identity?.playerId ? "er-me" : ""}>
          <span>{index + 1}. {displayName(player.codename, player.friendName)}{player.genesis ? " ◆" : ""}</span>
          <span>{player.score} pts · {player.items}/4 · {player.takedowns} takedowns · {player.deaths} losses</span>
        </li>)}
      </ol>
      <p className="er-fine">
        Career points are one for playing and two more for winning, so the standings reward
        turning up and coming first rather than a long match. The points beside each agent
        above are that match's score. Standings persist across matches and restarts. No RF
        changed hands: kits stay in your simulated FriendSDK inventory whether you win or lose.
      </p>
      <div className="er-row">
        {inLobby && <button type="button" className="er-primary" onClick={onAgain}>Back to the lobby</button>}
        <button type="button" onClick={onBack}>Leave lobby</button>
      </div>
    </div>
  </div>;
}
