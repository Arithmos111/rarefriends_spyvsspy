# The Rare Agency

**FriendSDK v0.1 · up to 4 players · simulated RF**

A Spy vs Spy–style stealth match for Rare Friends. Your Generations Friend is a spy
inside a nine-room embassy. Four pieces of intelligence are hidden in the furniture.
Search for them, booby-trap the furniture behind you, and reach the courtyard gate
with the full set before anyone else does.

Two to four agents share one embassy. Dozens of players can be in play at once
across separate lobbies.

## Running it

From the repository root:

```sh
npm run setup   # fetches, builds and installs the pinned FriendSDK commit
npm run dev
```

Open the printed URL. Connect a wallet holding a hardwired Rare Friends Generations
NFT (generation 1 or higher) on Robinhood mainnet (chain 4663), choose your Friend,
then create or join a lobby.

> **Be on Robinhood mainnet, chain 4663, before you connect.** The SDK only looks up your
> Friends once the wallet reports that chain. On any other network it skips discovery
> entirely but still shows "No playable Friends found", which is easy to read as "you own
> none". A Friend also has to be **hardwired**, meaning it has a permanent token-bound
> wallet; a temporary, balance-dependent Friend is not eligible. Open the same URL on a second device or browser to play
against yourself. The printed LAN URL works from a phone on the same wifi.

## Choosing your agent

The SDK's Friend picker lists Friends as text only, and a game cannot change that: the picker
is trusted runtime code outside the sandbox, and the game is handed one already-verified
Friend with no channel back. So the game confirms the choice immediately afterwards — the
agent is drawn at portrait scale under a spotlight with their codename, Friend number and
career record — and names the exact control in the SDK frame that switches to another. See
the known issues for the full shape of that gap.

## Title screen and training run

The game opens on an attract screen: the embassy at night, your own Friend drawn at portrait
scale from the canonical artwork, your career record, and three ways in — **Enter the embassy**,
**Training run**, and **Standings**.

The training run is a nine-step walkthrough of every control. It steps the real simulation in
the browser with no relay and no lobby, so it starts instantly and nothing another player does
can disturb it, and each step is cleared by actually performing the action rather than by
watching one: move, cross a doorway, search, take intelligence, trap furniture, trap a doorway,
strike, strike with the stiletto, escape. A step cannot be cleared until it has been readable
for a moment, so one you happen to satisfy on the way in is still shown.

**Got it — let me try** collapses the card to a slim bar naming the current step, so the room
underneath is clear to experiment in; **Show** brings it back. **Next step** moves on and
**Leave training** returns to the briefing, where the run can be started again. Lessons never
move your agent: the objective comes to wherever you are standing instead.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrow keys | Walk |
| On-screen stick | Walk (touch) |
| Tap or click the floor | Walk to that spot |
| Tap or click furniture in reach | Search it |
| **E** or the action button | Search, pick up, or escape — whichever is in reach |
| **F** | Strike the nearest agent |
| **Q** or the trap button | Open the trap menu for the furniture **or doorway** you are standing at |
| **1 / 2 / 3** | Set a letter bomb, spring trap or water bucket directly |
| **Esc** | Close a menu |

Strikes point where you are facing. A bare fist thrusts out on a short forearm; the stiletto
is drawn as a blade — tapered point, crossguard and grip — and stabs out along your facing and
back, which is what makes a near miss readable rather than a flash around the body.

Every trap has its own detonation, in the world and in the ear: a letter bomb throws a
shockwave and soot, a spring trap snaps shut in a metal star, a water bucket tips and splashes,
and each has a distinct sound. The agent who set it hears it spring from anywhere on the map
and is told who walked into it. Striking reads differently depending on what you are holding —
a bare fist flares, the stiletto sweeps a bright arc and lands as a slash — and detonations are
drawn over the room, so one is never hidden behind the furniture it was planted on.

Sound is off by default. Mute and reduce-motion live in the in-match settings menu (≡), and
reduced motion is also picked up from your system setting. If a Friend's artwork fails to load
it is drawn as a dashed placeholder with a **Retry artwork** control; the relay reconnects on
its own and says so in the match header while it is away.

## Rules

**Furnishing.** Every room is furnished from its own palette, so the twelve kinds of
furniture tell you where you are: filing cabinets and safes in the Records Vault,
consoles and lockers in the Signals Room, barrels in the Wine Cellar, tables and
bookcases in the Great Hall. Each kind is drawn as itself rather than as a labelled
box — drawers and handles, shelves of book spines, hooped staves, legs with daylight
under them — and no two pieces are ever placed close enough to clip each other. The
room's name plate hangs on whichever far wall has no doorway, and wall dressing is
kept clear of it.

**The embassy.** Nine rooms in a 3×3 block. You see only the room you are standing
in, so other agents are invisible until you walk in on them. Doorways sit at the
middle of each shared wall; you must line up with one to pass through.

**The intelligence.** Four items — secret documents, a forged passport, bearer bonds
and a disguise kit — are each hidden in one piece of furniture, in four different
rooms, never in the gate room. Searching takes 0.9s, or 0.55s with a lockpick.
Searched furniture stays searched for everyone.

**Traps.** A doorway is one opening shared by two rooms, so a trap on it fires on anyone who
crosses it in either direction, from either side, and can be spotted and disarmed from either
room.

Set a trap inside any untrapped piece of furniture, **or rig a doorway**. One trap
per target. A trapped doorway springs on the next agent who walks through it.

**Your own traps are live against you.** Forget where you left a letter bomb and it will take
you out exactly as it would a rival, and you get no credit for it. A disarm tool recovers any
trap including your own, returning it to your kit.

| Trap | Effect |
| --- | --- |
| Letter bomb | Takes the searcher out |
| Spring trap | Takes the searcher out |
| Water bucket | Freezes the searcher for 3 seconds; nothing is dropped |

A trap detector reveals rival traps in your current room. A disarm tool removes a
rival trap and adds it to your own stock.

**Fighting.** Agents have **5 health**. A bare-handed strike takes 1, so five landed blows put
someone down. Attacks have a 0.75s cooldown and agents are protected for 1.5s after spawning.
Lethal traps ignore health entirely.

**Power-ups** are hidden in furniture alongside the intelligence, and picking one up applies it
immediately.

| Power-up | Effect |
| --- | --- |
| Field medkit | Restores 3 health, up to your maximum |
| Ballistic vest | Raises your maximum health by 1, and heals you for it. Respawns restore the raised maximum |
| Stiletto knife | Your strikes hit for 2 instead of 1 |

**There is exactly one knife per match.** It is a random drop hidden in one piece of furniture.
Whoever carries it shows a knife badge above their head, so the room knows who to avoid, and
they drop it where they fall when taken down. It keeps circulating all match.

**Being taken out.** You drop everything you are carrying on the floor of that room,
where anyone can pick it up, and you return at your starting room after 4 seconds.

**Winning.** Carry all four items to the courtyard gate in the centre room and escape, which
plays out as a run across the apron to a waiting aircraft. If the 5-minute clock runs out first,
the agent holding the most intelligence wins; a tie means nobody wins.

**Scoring and career standings.** Every finished match adds to a running total kept per Rare
Friend on the relay, which survives restarts and redeploys.

| Award | Points |
| --- | --- |
| Escaping with the full set | 100 |
| Leading on intelligence when time expires | 40 |
| Each item recovered and still held | 10 |
| Each takedown | 5 |
| Surviving to the end | 5 |

Items you are carrying stop counting the moment you drop them, so holding a lead means staying
alive. A trap you set yourself is nobody's takedown. Standings are reachable from the briefing
room.

**Naming your Friend.** From the briefing room you can give your Friend a name, shown in
parentheses after your codename everywhere: `FALCON (Nightjar)`. The name belongs to the Friend
rather than to the session, so it comes back next time you connect.

**Reading the screen.** The match header carries a nine-cell plan of the embassy showing where
you are, where you have already been and where the gate is; a four-slot mission track showing
which intelligence you hold and which is still out there; and a health bar. Picking anything up
flashes its icon and name in the centre of the screen.

## Economy — exact values

All RF, crates, kits and redemptions are **simulated** by the SDK's preview client.
No transaction is sent and no contract is deployed. RF uses 18-decimal bigint base units.

| Rule | Exact value |
| --- | --- |
| Consumable | Gadget Crate |
| Price | 1 RF (`1000000000000000000` base units) |
| Outcomes per crate | Exactly one kit |
| Expected reward | 0.905 RF per crate |
| Maximum prize | 8 RF |
| Backing | Every purchased crate reserves 8 RF; kept kits retain their fixed RF value with no redemption expiry |

| Kit | Weight | Redeems for | Contents |
| --- | --- | --- | --- |
| Standard Issue Kit | 6,000 bps (60%) | 0.5 RF | 2 bombs, 2 springs, 1 bucket |
| Demolition Kit | 2,500 bps (25%) | 1 RF | 4 bombs, 2 springs, 1 bucket |
| Counter-Intel Kit | 1,200 bps (12%) | 2 RF | 2 bombs, 2 springs, 2 buckets, detector |
| Ghost Kit | 250 bps (2.5%) | 3 RF | 3 bombs, 2 springs, 2 buckets, detector, lockpick |
| Director's Kit | 50 bps (0.5%) | 8 RF | 4 bombs, 3 springs, 3 buckets, detector, lockpick, disarm tool |

Weights total exactly 10,000 basis points.

**Consumable rules.** Buying a crate costs 1 RF. Opening a crate consumes it and
draws exactly one kit into your Friend's inventory. Kits are permanent: equipping one
for a match is free and unlimited, and playing a match never consumes a kit.
Redeeming a kit pays its fixed RF value and removes it from your inventory, so the
real choice is to keep a kit for its loadout or cash it in.

**Field Issue** (2 bombs, 1 spring) is always available and is never bought, drawn or
consumed, so owning no kit never blocks play.

**Genesis perk.** An agent whose Friend's owner also holds a Rare Friends Genesis NFT
carries one extra letter bomb and shows a GENESIS badge. This is a perk only: the
required gate is the SDK's verified Generations check, exactly as shipped. See the
known issues below — the perk is inactive until a Genesis contract address is configured.

## Identity

The SDK runtime owns wallet connection, owned-Friend discovery and the fresh
`readGenerationEligibility` check. This component never connects a wallet, never
enumerates token IDs and never implements its own ownership gate; it receives an
already-verified `friendId` and the fixed action client.

Every agent in a match is drawn with their own Friend's canonical sprites, read from
the pinned artwork deployment through the SDK's public sprite reader. Sprites are
drawn at 5× integer scale in an 80×80 box with the canonical white one-pixel halo
over the black mask, clipped to the box. Nothing is rotated, stretched, smoothed,
recoloured or regenerated. Colossus Friends use the SDK's explicit horizontal fallback.

## Multiplayer

Matches are decided by an authoritative relay served from this page's own origin, not
by the browser. FriendSDK's sandbox allows `connect-src 'self'`, so a same-origin
WebSocket is the only realtime transport available to a game frame — the relay is
attached to the SDK's own static server rather than replacing it, and the child
document's Content-Security-Policy is unchanged.

The client predicts only its own movement, using the exact simulation file the server
runs, and is corrected by every snapshot. Snapshots are scoped to the room you are
standing in, so a modified client cannot see items, traps or agents elsewhere in
the embassy.

## Checks

Run from the repository root:

```sh
npm run typecheck
npm test
npm run check:game
npm run check:browser
```

This directory is also drop-in valid inside a FriendSDK checkout. Copied to `games/rare-agency`
there, the SDK's own `npm run check:games` reports it valid, and the SDK's `npm test` (111 tests,
109 passed, 2 skipped where Foundry is unavailable) and `npm run typecheck` stay clean.

`npm test` covers the simulation: map determinism and walkability, item placement,
doorways, searching, traps, combat, drops, escaping, the timer, the client and server
agreeing step for step, and that every furniture type can be reached from every side. `npm run check:browser` drives two real browsers
through the SDK's ownership gate, buys and opens a crate, creates and joins a lobby,
plays a live match and asserts the SDK container bounds hold at desktop and phone
widths.

## Known issues and capability gaps

- **The relay trusts the Friend ID a client claims.** The sandboxed game frame cannot
  sign anything, so the server verifies that the claimed Generations token exists and
  reads its owner over RPC, but it cannot prove the connected player controls that
  token. Closing this needs a signed session attestation from the trusted runtime,
  which SDK v0.1 does not expose. Nothing of value depends on it today: the economy is
  simulated and lives in the SDK's per-Friend preview ledger, not on the relay.
- **The Genesis perk is inactive by default.** FriendSDK v0.1 does not publish a Rare
  Friends Genesis contract address. Set `RF_GENESIS_ADDRESS` to enable the perk; until
  then every agent is treated as a non-holder and no badge is shown.
- **Preview state is session-local.** The SDK's simulated ledger resets on reload, so
  kits bought in one session are gone in the next. Persisting them needs the on-chain
  phase.
- **Career standings are only as trustworthy as the Friend ID a client claims.** Match
  results are recorded per Friend on the relay and survive restarts, but they inherit
  the verification gap above: a client that claims another Friend's ID would have its
  results filed under that ID. The same applies to the name shown in parentheses.
- **Winning pays nothing.** Standings are a scoreboard, not a reward. Awarding RF for a
  match win would need contract support for a skill-decided payout, which the v0.1
  chance-game contract does not model.
- **A portrait phone is cramped.** The SDK container is a fixed 3:2 box, so upright
  phones get a small stage. The game stays playable and shows a prompt to rotate.
- **Reconnecting mid-match rejoins as a new agent** rather than resuming the old one.
- **The SDK's Friend picker does not scale to a large collection.** It renders owned
  Friends as a flat list of text buttons with no artwork, no search and no ordering, so
  a wallet holding hundreds is painful to choose from. Discovery itself handles up to
  10,000. This cannot be fixed from game code: the SDK's AGENTS.md forbids a game
  implementing another Friend selector, and `GameHostProps` exposes no hook for an
  initial Friend, an ordering or a row renderer. The title screen shows the selected
  Friend's artwork at portrait scale, which is the nearest a game can get. Raised as
  SDK feedback in the submission.
- **A wrong-network wallet looks identical to owning no Friends.** The SDK runtime shows
  "Switch your wallet to Robinhood mainnet (4663)" and "No playable Friends found" at the
  same time, because discovery only runs once the wallet reports chain 4663 and otherwise
  never queries at all. The definitive-sounding second message is the one people read. This
  cost real time during our first live deployment. The gate is trusted runtime code, so a
  game cannot correct it; suppressing the empty-list message whenever the wallet is on the
  wrong chain would fix it in the SDK.

## Assets

All embassy artwork — floors, walls, furniture, doorways, room signs, wall decoration, the
gate, traps, item glyphs and the escape sequence — is drawn procedurally on a canvas by
`render.ts` in this directory. There are no third-party image or font files.

**All audio is synthesised at runtime**, in `audio.ts`, using Web Audio oscillators and
filtered noise. There are no audio files to download or license. The background music is a slow
spy-movie ostinato in E minor at 92 BPM, built from a triangle-wave walking bass, a sparse
square-wave answering line and noise percussion. Sound effects are short enveloped tones from
the same synthesis. The SDK's own sound kit is still used for the economy actions.

Rare Friend character sprites are the canonical on-chain artwork, read through the SDK and
never modified.

The palette follows the Rare Friends direction: pale monochrome scenery with black
line art and signal green `#CCFF00` marking everything interactive, plus one alert
colour for danger.
