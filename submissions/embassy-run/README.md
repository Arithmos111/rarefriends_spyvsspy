# Embassy Run — four-player Spy vs Spy

Up to four Rare Friends raid one embassy for four pieces of hidden intelligence, booby-trapping the furniture behind them, racing to escape through the courtyard gate.

**Builder:** [@Arithmos111](https://github.com/Arithmos111) · **Category:** Economy Potential · **SDK:** FriendSDK v0.1 (0.1.0)

Your selected Generations Friend is the spy, drawn from its own canonical on-chain sprites, and every rival agent in the room is drawn from theirs. Matchmaking lobbies let dozens of players run separate four-player embassies at once. [Source code](https://github.com/Arithmos111/rarefriends_spyvsspy/tree/REPLACE_SHA) · [Game rules](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/embassy-run/game.json) · [Full rules and controls](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/embassy-run/README.md)

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

**This game is multiplayer, so it needs a second player.** `npm run dev` also prints a LAN URL: open it on a phone on the same wifi, or open the same URL in a second browser window, and play against yourself. No hosted demo is provided yet; a `Dockerfile` and `fly.toml` are included for one-command deployment.

## Play

Move with WASD, arrow keys, the on-screen stick, or by tapping a destination. **E** searches furniture, picks up dropped items and escapes through the gate, whichever is in reach. **F** strikes a nearby agent. **Q** opens the trap menu for the furniture you are standing at; **1**, **2** and **3** set a trap directly. Tapping furniture within reach searches it.

Nine rooms in a 3×3 block. You see only the room you are standing in, so rivals are invisible until you walk in on them. Four items — secret documents, a forged passport, bearer bonds and a disguise kit — are each hidden in one piece of furniture in four different rooms. Searching takes 0.9s, or 0.55s with a lockpick.

Set a trap inside any untrapped furniture you are standing at; it springs on anyone who searches it except you. Letter bombs and spring traps take the searcher out, and a water bucket freezes them for 3 seconds. Being taken out drops everything you carry on that room's floor for anyone to collect, and you return after 4 seconds. Two strikes also take an agent down.

Carry all four items to the courtyard gate in the centre room to win. If the 5-minute clock expires first, the agent holding the most intelligence wins; a tie means nobody does. Settings (≡) hold mute and reduce-motion; failed Friend artwork can be retried. Everything stays inside the SDK's 960 × 640 container.

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

From an SDK checkout with `games/embassy-run` copied in: `npm test` (111 tests, 109 passed, 2 skipped because Foundry is unavailable), `npm run typecheck` (clean) and `npm run check:games` (`games/embassy-run: valid; expected reward 905000000000000000; maximum 8000000000000000000 RF base units`) all pass. The SDK's `npm run check:browser` passes unchanged.

This repository additionally runs `npm run check`: typecheck, 23 simulation tests (map determinism, doorways, searching, traps, combat, drops, escaping, the timer, client/server step-for-step agreement, and that every furniture type is reachable from every side), a game validation mirroring the SDK's rule for `games/`, and a browser check that drives **two** real browsers through the SDK ownership gate, buys and opens a crate, creates and joins a lobby, and plays a live match, asserting SDK container bounds at desktop and phone widths. All pass.

Browser tests use the SDK's own internal identity fixture for mocked wallets and RPC; **a real-wallet playthrough is still outstanding.** The Dockerfile could not be built in the development environment because its network policy blocks Docker Hub's blob CDN; its runtime file set and healthcheck were verified directly instead.

All embassy artwork — floors, walls, furniture, doorways, the gate, traps and items — is drawn procedurally on a canvas. **There are no third-party image, font or audio assets.** Sounds come from the SDK's sound kit. Rare Friend sprites are the canonical on-chain artwork read through the SDK's public sprite reader at 5× integer scale in an 80 × 80 box with the canonical white one-pixel halo over the black mask, never rotated, stretched, smoothed, recoloured or regenerated; Colossus Friends use the SDK's explicit horizontal fallback.

**Needs future SDK support.** Realtime multiplayer required a same-origin WebSocket, because the sandbox CSP allows `connect-src 'self'` and the Rare Friends RPC only; the relay therefore attaches to the SDK's own static server and leaves its CSP untouched, but this means the game cannot be hosted as pure static files. The relay cannot verify that a client controls the Friend ID it claims, since the sandbox exposes no signing; closing that needs a signed session attestation from the trusted runtime. Awarding RF for winning a match would need a contract that settles a skill-decided outcome, which the v0.1 chance-game contract does not model. Preview state is session-local, so kits do not persist between sessions.

No trading, wearable NFTs, creator fees or live economy is included. **Token Activity metrics are not claimed.** Production publication needs separate Rare Friends review.
