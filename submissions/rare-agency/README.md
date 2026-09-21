# The Rare Agency — four-player Spy vs Spy

Up to four Rare Friends raid one embassy for four pieces of hidden intelligence, booby-trapping the furniture and doorways behind them, racing to escape through the courtyard gate before the others.

**Builder:** [@Arithmos111](https://github.com/Arithmos111) · **Category:** Character Spotlight (also entered for Economy Potential) · **SDK:** FriendSDK v0.1 (0.1.0)

Your selected Generations Friend is the spy, drawn from its own canonical on-chain sprites, and every rival agent in the room is drawn from theirs. Matchmaking lobbies let dozens of players run separate four-player embassies at once. [Source code](https://github.com/Arithmos111/rarefriends_spyvsspy/tree/REPLACE_SHA) · [Game rules](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/game.json) · [Full rules and controls](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/README.md)

**Playable preview: <https://rareagency.rwplay.net>** — needs a browser wallet holding a hardwired Rare Friends Generations NFT (generation ≥ 1) on **Robinhood mainnet, chain 4663**. Switch networks before connecting: on any other chain the SDK reports "No playable Friends found" even when you hold several. Multiplayer needs a second player; open the link on a phone as well to play against yourself.

## Run it

Use Node.js **22.18+** on Linux or Ubuntu/WSL2, plus a browser wallet holding a hardwired Rare Friends Generations NFT (generation ≥ 1) on Robinhood mainnet (4663).

```sh
git clone https://github.com/Arithmos111/rarefriends_spyvsspy.git
cd rarefriends_spyvsspy
git checkout REPLACE_SHA
npm run setup
npm run dev
```

`npm run setup` fetches, builds and installs FriendSDK at pinned commit `da4828f8ec49d8ac5c24556908bd4cd653f8db67`. The SDK is published UNLICENSED, so it is fetched rather than vendored into this repository.

Open the printed URL (normally `http://localhost:4173`), connect your wallet and select your Friend. The SDK verifies ownership before play. No RF funding or transaction signature is needed for this simulated preview.

`npm run dev` also prints a LAN URL, so open it on a phone on the same wifi or in a second browser window to fill a lobby. `Dockerfile`, `docker-compose.yml` and `Caddyfile` deploy the same build behind automatic TLS, which is how the preview above is hosted; see [docs/DEPLOY.md](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/docs/DEPLOY.md).

## Play

The game opens on your own agent, drawn at portrait scale from their canonical on-chain sprites, then a title screen with a **Training run** beside it — a nine-step walkthrough of every control, played against the real simulation with no relay and no lobby, so it starts instantly and needs no second player.

Move with WASD, arrow keys, the on-screen stick, or by tapping a destination. **E** searches furniture, picks up dropped items and escapes through the gate, whichever is in reach. **F** strikes the way you are facing. **Q** opens the trap menu for the furniture or doorway you are standing at; **1**, **2** and **3** set a trap directly.

Nine rooms in a 3×3 block, and you see only the room you are standing in, so rivals are invisible until you walk in on them. Four items — secret documents, a forged passport, bearer bonds and a disguise kit — are hidden in four different rooms, always in that room's marked cache, so once you know a room is worth searching you know where to run. Searching takes 0.9s, or 0.55s with a lockpick. Wall clocks and framed portraits are searchable and trappable too.

Trap any untrapped furniture, or rig a doorway — a doorway is one opening shared by two rooms, so a trap on it fires on anyone crossing either way, from either side. Letter bombs and spring traps take the victim out; a water bucket freezes them for 3 seconds. **Your own traps are live against you**, and catching yourself is nobody's takedown. A disarm tool recovers any trap.

Agents have **5 health**. A strike takes 1, or 2 with the stiletto — **exactly one per match**, a random drop that badges its carrier and falls where they fall. Medkits restore 3, ballistic vests raise the maximum by 1. Being taken out drops everything you carry and you return after 4 seconds.

Carry all four items to the courtyard gate in the centre room to win, which plays out as a run across an airport apron to a waiting aircraft. If the 5-minute clock expires first, the agent holding the most intelligence wins; a tie means nobody does.

**Career standings** are kept per Rare Friend on the relay and persisted to disk, so they survive restarts: **one point for playing and two more for winning**, which rewards turning up and coming first rather than grinding a match already lost. The result screen shows your place and what you earned. Players can also name their Friend, shown in parentheses after the codename, stored against the Friend rather than the session.

The match header carries a nine-cell plan of the embassy, a four-slot mission track and a health bar; picking anything up flashes its icon centre-screen. Sound and music ship on, with a toggle in the header on every screen outside a match, and settings (≡) hold both toggles and reduce-motion. Everything stays inside the SDK's 960 × 640 container, keyboard and touch alike.

## Rules and rewards

**All balances, purchases and rewards are simulated** by the SDK's preview client and labelled as such in the UI. No contract is deployed and no transaction is sent.

One **Gadget Crate** costs **1 RF** and opens into exactly one gadget kit.

| Kit | Chance | Redemption value | Contents |
|---|---:|---:|---|
| Standard Issue Kit | 60% | 0.5 RF | 2 bombs, 2 springs, 1 bucket |
| Demolition Kit | 25% | 1 RF | 4 bombs, 2 springs, 1 bucket |
| Counter-Intel Kit | 12% | 2 RF | 2 bombs, 2 springs, 2 buckets, detector |
| Ghost Kit | 2.5% | 3 RF | 3 bombs, 2 springs, 2 buckets, detector, lockpick |
| Director's Kit | 0.5% | 8 RF | 4 bombs, 3 springs, 3 buckets, detector, lockpick, disarm tool |

Weights total exactly **10,000 basis points**. Expected reward **0.905 RF per crate**. Each purchased crate reserves the maximum **8 RF** prize; kept kits retain their RF backing with no redemption expiry. New purchases stop when free backing is insufficient. RF uses 18-decimal bigint base units.

**Consumable rules.** Buying a crate costs 1 RF. Opening a crate consumes it and draws exactly one kit into the Friend's inventory. Kits are permanent: equipping one for a match is free and unlimited, and playing a match never consumes a kit. Redeeming a kit pays its fixed RF value and removes it, so the real decision is to keep a kit for its loadout or cash it in — that tension is the intended economy. A free **Field Issue** kit (2 bombs, 1 spring) is always available and is never bought, drawn or consumed, so owning no kit never blocks play. Preview progress resets when the runtime session ends.

**Access.** The gate is the SDK's verified Generations check, exactly as shipped. Genesis holders additionally carry one extra letter bomb and a GENESIS badge; see known issues for why that perk ships inactive.

## Checks, credits and limitations

`npm run check` runs typecheck, **62 simulation tests**, game validation and two browser checks. All pass. The simulation tests cover map determinism, walkability and furniture reachability, doorways and two-way doorway traps, searching, combat and drops, power-ups, escaping, the timer, career scoring, and step-for-step agreement between the client's prediction and the server. Game validation reports `games/rare-agency: valid`, weights totalling 10,000 bps, expected reward 0.905 RF and a maximum prize of 8 RF. The browser check drives **two** real browsers through the SDK ownership gate, asserts container bounds at desktop and phone widths, buys and opens a crate, walks the nine-step training run, creates and joins a lobby and plays a live match; a second check proves the reverse-proxy topology the hosted preview runs behind.

Browser tests use the SDK's own internal identity fixture for mocked wallets and RPC. **A real-wallet playthrough has been done against the hosted preview above**, which is how the wrong-network problem in the feedback below was found.

**Known issues.** The relay verifies that a claimed Generations token exists and reads its owner over RPC, but cannot prove the connected player controls it, because the sandbox exposes no signer — so career standings inherit that gap. An RPC outage blocks the SDK's picker entirely, though players already in a match keep playing. The Genesis perk (one extra letter bomb, plus a badge) is inactive until `RF_GENESIS_ADDRESS` is configured, since FriendSDK v0.1 publishes no Genesis address. Audio and motion preferences reset on reload, because the sandbox's opaque origin makes `localStorage` throw. A restart ends matches in progress. Full list: [known issues and capability gaps](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/README.md#known-issues-and-capability-gaps).

**Feedback for the SDK team** — three things that cost real time and cannot be worked around from inside a game: [docs/SDK-FEEDBACK.md](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/docs/SDK-FEEDBACK.md).

All embassy artwork — floors, walls, furniture, doorways, room name plates, wall dressing, the gate, traps, item glyphs and the escape sequence — is drawn procedurally on a canvas. **There are no third-party image, font or audio assets.** All audio is synthesised at runtime with Web Audio oscillators and filtered noise: the background music is a slow spy-movie ostinato in E minor at 92 BPM over a triangle-wave walking bass, and every sound effect is a short enveloped tone from the same synthesis. The SDK's sound kit is still used for economy actions. Rare Friend sprites are the canonical on-chain artwork read through the SDK's public sprite reader at 5× integer scale in an 80 × 80 box with the canonical white one-pixel halo over the black mask, never rotated, stretched, smoothed, recoloured or regenerated; Colossus Friends use the SDK's explicit horizontal fallback.

No trading, wearable NFTs, creator fees or live economy is included. **Token Activity metrics are not claimed.** Production publication needs separate Rare Friends review.
