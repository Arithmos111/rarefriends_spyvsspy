# The Rare Agency — four-player Spy vs Spy

Up to four Rare Friends raid one embassy for four pieces of hidden intelligence, booby-trapping the furniture and doorways behind them, racing to escape through the courtyard gate before the others.

**Builder:** [@Arithmos111](https://github.com/Arithmos111) · **Category:** Economy Potential · **SDK:** FriendSDK v0.1 (0.1.0)

Your selected Generations Friend is the spy, drawn from its own canonical on-chain sprites, and every rival agent in the room is drawn from theirs. Matchmaking lobbies let dozens of players run separate four-player embassies at once. [Source code](https://github.com/Arithmos111/rarefriends_spyvsspy/tree/REPLACE_SHA) · [Game rules](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/game.json) · [Full rules and controls](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/README.md)

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

**Switch your wallet to Robinhood mainnet (chain 4663) before connecting, and use a hardwired Friend.** On any other chain the SDK skips discovery but still reports "No playable Friends found", which reads as though you own nothing. See the SDK feedback below.

**This game is multiplayer, so it needs a second player.** `npm run dev` also prints a LAN URL: open it on a phone on the same wifi, or open the same URL in a second browser window, and play against yourself. No hosted demo is provided yet; a `Dockerfile` and `fly.toml` are included for one-command deployment.

## Play

The SDK's Friend picker lists Friends as text only and cannot be changed from a game, so the entry confirms the choice straight afterwards: the chosen agent is drawn at portrait scale with their codename, Friend number and career record, and the exact control that switches Friend is named. Strikes point where you are facing, with the stiletto drawn as a blade that stabs out and back.

Everything opens on a title screen showing your own Friend at portrait scale, your career record and a **Training run** — a nine-step walkthrough of every control, played against the real simulation with no relay and no lobby, so it starts instantly. It teaches moving, doorways, searching, taking intelligence, trapping furniture, trapping a doorway, striking, the stiletto, and escaping, in that order. It is reachable again from the briefing at any time.

Move with WASD, arrow keys, the on-screen stick, or by tapping a destination. **E** searches furniture, picks up dropped items and escapes through the gate, whichever is in reach. **F** strikes a nearby agent. **Q** opens the trap menu for the furniture you are standing at; **1**, **2** and **3** set a trap directly. Tapping furniture within reach searches it.

Nine rooms in a 3×3 block. You see only the room you are standing in, so rivals are invisible until you walk in on them. Four items — secret documents, a forged passport, bearer bonds and a disguise kit — are each hidden in one piece of furniture in four different rooms. Searching takes 0.9s, or 0.55s with a lockpick.

Every room also hangs a wall clock or a framed portrait, searchable and trappable like anything else. Set a trap inside any untrapped furniture, or rig a doorway — a doorway is one opening shared by two rooms, so a trap on it fires on anyone crossing it in either direction, from either side. Letter bombs and spring traps take the victim out; a water bucket freezes them for 3 seconds. **Your own traps are live against you**, and catching yourself is nobody's takedown. A disarm tool recovers any trap, including your own.

Agents have **5 health**. A strike takes 1, or 2 with the stiletto. Hidden alongside the intelligence are medkits (restore 3), ballistic vests (raise the maximum by 1) and **exactly one stiletto knife per match**, a random drop that doubles damage, badges its carrier so the room can see them, and falls where they fall. Being taken out drops everything you carry, knife included, and you return after 4 seconds.

Carry all four items to the courtyard gate in the centre room to win, which plays out as a run across an airport apron to a waiting aircraft. If the 5-minute clock expires first, the agent holding the most intelligence wins; a tie means nobody does.

The match header carries a nine-cell plan of the embassy, a four-slot mission track showing what you hold and what is still missing, and a health bar. Picking anything up flashes its icon and name centre-screen. Sound and music ship switched on, with a toggle in the header on every screen outside a match; settings (≡) hold both toggles and reduce-motion; failed Friend artwork can be retried. Everything stays inside the SDK's 960 × 640 container.

**Career standings.** Every finished match adds to a total kept per Rare Friend on the relay, persisted to disk so it survives restarts: 100 for escaping with the full set, 40 for leading on time, 10 per item still held, 5 per takedown, 5 for surviving. Items stop counting once dropped. Players can also name their Friend, shown in parentheses after the codename everywhere, stored against the Friend rather than the session.

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

**Genesis.** The required gate is the SDK's verified Generations check, exactly as shipped. Genesis holders additionally carry one extra letter bomb and show a GENESIS badge. FriendSDK v0.1 publishes no Genesis contract address, so the perk is inactive until `RF_GENESIS_ADDRESS` is configured.

## Checks, credits and limitations

From an SDK checkout with `games/rare-agency` copied in: `npm test` (111 tests, 109 passed, 2 skipped because Foundry is unavailable), `npm run typecheck` (clean) and `npm run check:games` (`games/rare-agency: valid; expected reward 905000000000000000; maximum 8000000000000000000 RF base units`) all pass. The SDK's `npm run check:browser` passes unchanged.

This repository additionally runs `npm run check`: typecheck, 23 simulation tests (map determinism, doorways, searching, traps, combat, drops, escaping, the timer, client/server step-for-step agreement, and that every furniture type is reachable from every side), a game validation mirroring the SDK's rule for `games/`, and a browser check that drives **two** real browsers through the SDK ownership gate, buys and opens a crate, creates and joins a lobby, and plays a live match, asserting SDK container bounds at desktop and phone widths. All pass.

Browser tests use the SDK's own internal identity fixture for mocked wallets and RPC; **a real-wallet playthrough is still outstanding.** The Dockerfile could not be built in the development environment because its network policy blocks Docker Hub's blob CDN; its runtime file set and healthcheck were verified directly instead.

All embassy artwork — floors, walls, furniture, doorways, room name plates, wall dressing, the gate, traps, item glyphs and the escape sequence — is drawn procedurally on a canvas. **There are no third-party image, font or audio assets.** All audio is synthesised at runtime with Web Audio oscillators and filtered noise: the background music is a slow spy-movie ostinato in E minor at 92 BPM over a triangle-wave walking bass, and every sound effect is a short enveloped tone from the same synthesis. The SDK's sound kit is still used for economy actions. Rare Friend sprites are the canonical on-chain artwork read through the SDK's public sprite reader at 5× integer scale in an 80 × 80 box with the canonical white one-pixel halo over the black mask, never rotated, stretched, smoothed, recoloured or regenerated; Colossus Friends use the SDK's explicit horizontal fallback.

**SDK feedback from a live deployment.** A wallet on the wrong chain is indistinguishable from owning no Friends. `GameHost` only runs `readOwnedFriends` once the wallet session reports chain 4663; on any other chain it never queries, yet the picker still renders "No playable Friends found" directly beneath the "Switch your wallet to Robinhood mainnet (4663)" alert. The definitive-sounding message is the one people act on, and this cost real debugging time while deploying this entry with six eligible Friends in the connected wallet. Suppressing the empty-list message while `wallet.status === "wrong-network"` would resolve it. A game cannot work around this, since the picker and the ownership gate are trusted runtime code that runs before the game component mounts. Relatedly, "hardwired" is load-bearing but easy to miss: a temporary, balance-dependent Friend with no permanent token-bound wallet is not eligible, and the picker does not distinguish it from a wrong-network result either.

**SDK feedback: the Friend picker does not scale to a large collection.** `GameFrame` renders the owned Friends as one flat `friends.map(...)` of text buttons, each showing only the label and "Hardwired Generations". Discovery itself is fine — `readOwnedFriends` supports up to 10,000 NFTs per account — but a wallet holding hundreds produces hundreds of identical, unordered, unsearchable buttons in a menu, with no artwork to tell them apart. Three changes would fix it, all in the runtime: render each Friend's sprite beside its label using the artwork routine the SDK already ships (`createFriendReader`/`spriteFrame`); add a filter box matching on token ID and label; and sort or pin by most recently selected, which the runtime could persist since it owns the selection. A game cannot do any of this: AGENTS.md forbids implementing "an ownership gate or another Friend selector in game code", and `GameHostProps` exposes no hook for an initial Friend, a sort order, or a custom row renderer. This entry shows the selected Friend's artwork at portrait scale on its own title screen, which is the nearest a game can get — after selection rather than during it.

**Needs future SDK support.** Realtime multiplayer required a same-origin WebSocket, because the sandbox CSP allows `connect-src 'self'` and the Rare Friends RPC only; the relay therefore attaches to the SDK's own static server and leaves its CSP untouched, but this means the game cannot be hosted as pure static files. The relay cannot verify that a client controls the Friend ID it claims, since the sandbox exposes no signing; closing that needs a signed session attestation from the trusted runtime. Awarding RF for winning a match would need a contract that settles a skill-decided outcome, which the v0.1 chance-game contract does not model. Preview state is session-local, so kits do not persist between sessions.

No trading, wearable NFTs, creator fees or live economy is included. **Token Activity metrics are not claimed.** Production publication needs separate Rare Friends review.
