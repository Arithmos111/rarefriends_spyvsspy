# The Rare Agency — four-player Spy vs Spy

Up to four Rare Friends raid one embassy for four pieces of hidden intelligence, booby-trapping the furniture and doorways behind them, racing to escape through the courtyard gate before the others.

**Builder:** [@Arithmos111](https://github.com/Arithmos111) · [@arithmos0x](https://x.com/arithmos0x) on X · `arithmosxtg` on Telegram · **Category:** Character Spotlight (also entered for Economy Potential) · **SDK:** FriendSDK v0.1.2

Your selected Generations Friend is the spy, drawn from its own canonical on-chain sprites, and every rival in the room is drawn from theirs. Matchmaking lobbies let dozens of players run separate four-player embassies at once.

**Playable preview: <https://rareagency.rwplay.net>** — needs a browser wallet holding a hardwired Generations NFT (generation ≥ 1) on **Robinhood mainnet, chain 4663**. It is multiplayer, so open it on a phone too to play against yourself.

[Source code](https://github.com/Arithmos111/rarefriends_spyvsspy/tree/REPLACE_SHA) · [Game rules](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/game.json) · [Full rules and controls](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/README.md)

## Run it

Needs Node.js **22.18+** on Linux or Ubuntu/WSL2, plus the same wallet as above.

```sh
git clone https://github.com/Arithmos111/rarefriends_spyvsspy.git
cd rarefriends_spyvsspy
git checkout REPLACE_SHA
npm run setup
npm run dev
```

`npm run setup` fetches, builds and installs FriendSDK v0.1.2 at pinned commit `762d6f58a73ace723f7f82dc1a61bfa036c21edc`; the SDK is UNLICENSED, so it is fetched rather than vendored. Open the printed URL, connect your wallet and pick your Friend; the SDK verifies ownership, and no RF or signature is needed for this simulated preview. `npm run dev` also prints a LAN URL for a second device. `Dockerfile`, `docker-compose.yml` and `Caddyfile` deploy the same build behind automatic TLS — how the preview is hosted ([docs/DEPLOY.md](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/docs/DEPLOY.md)).

## Play

The game opens on your agent at portrait scale, then a title screen offering a **Training run** — nine steps through every control — and a **Demo match** against one to three computer agents: a real five-minute match, escape sequence and recap included, that never touches the standings. Both run in the browser with no relay, lobby or second player. Rookie, Field agent and Veteran change how fast the opposition reacts and how much it remembers, never how hard it hits; it sees only the room it stands in and walks into your traps.

Move with WASD, arrow keys, the on-screen stick or by tapping a destination. **E** searches, picks up and escapes through the gate, whichever is in reach; **F** strikes the way you are facing; **Q** opens the trap menu for the furniture or doorway you are at, and **1**–**3** set a trap directly. The header carries a plan of the embassy, a four-slot mission track and a health bar. Settings (≡) hold mute, music and reduced motion. Everything stays in the SDK's 960 × 640 container, keyboard and touch alike.

Nine rooms in a 3×3 block, and you see only the room you stand in, so rivals are invisible until you walk in on them. Four items — documents, passport, bearer bonds, disguise kit — sit in four different rooms, always in that room's marked cache, so once you know a room is worth searching you know where to run. Searching takes 0.9s, or 0.55s with a lockpick; wall clocks and portraits hide things too.

Trap any untrapped furniture, or rig a doorway — one opening shared by two rooms, so it fires on anyone crossing either way. Bombs and spring traps kill; a bucket freezes for 3 seconds. **Your own traps are live against you**, and catching yourself is nobody's takedown.

Agents have **5 health**. A strike takes 1, or 2 with the stiletto — **exactly one per match**, a random drop that badges its carrier. Medkits restore 3, vests add 1 to the maximum. Dying drops everything; you return after 4 seconds.

Carry all four items to the courtyard gate to win. If the 5-minute clock expires first, whoever holds the most intelligence wins; a tie means nobody does. **Career standings**, kept per Friend on the relay and persisted to disk, pay **one point for playing and two more for winning**, so the board rewards turning up and coming first rather than grinding a lost match.

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

Weights total exactly **10,000 basis points**; expected reward **0.905 RF per crate**. Each crate reserves the maximum **8 RF** prize, kept kits retain their backing with no expiry, and purchases stop when free backing runs short. RF uses 18-decimal bigint base units.

**Consumable rules.** Opening a crate consumes it and draws one kit. Kits are permanent: equipping is free and unlimited, and playing never consumes one. Redeeming pays its fixed RF value and removes it, so the decision is loadout or cash — that tension is the intended economy. A free **Field Issue** kit (2 bombs, 1 spring) is never bought, drawn or consumed, so owning no kit never blocks play. Preview progress resets with the runtime session.

**Access.** The gate is the SDK's verified Generations check, exactly as shipped. Genesis holders additionally carry one extra letter bomb and a GENESIS badge, read from the Genesis contract over the same RPC.

## Checks, credits and limitations

`npm run check` runs typecheck, **97 simulation tests**, game validation and two browser checks. **All pass.** The tests cover map determinism, reachability, two-way doorway traps, searching, combat, power-ups, escaping, the timer, career scoring, the end-of-match recap, the lobby's ready timeout, and step-for-step agreement between the client's prediction and the server; they also play whole matches against the computer agents, which never walk through a wall, stall, or know a room they have not stood in. Validation reports `games/rare-agency: valid`, 10,000 bps, 0.905 RF expected, 8 RF maximum. The browser check drives **two** real browsers through the SDK ownership gate, asserts container bounds at desktop and phone widths, buys and opens a crate, walks the training run, plays a four-agent demo match and plays a live match in a shared lobby; a second proves the reverse-proxy topology the preview runs behind.

Browser tests use the SDK's own identity fixture for mocked wallets and RPC. **A real-wallet playthrough has been done against the hosted preview**, which is how the wrong-network problem reported to the SDK team was found — since fixed upstream in v0.1.2.

**Known issues.** The relay confirms a claimed token exists and reads its owner over RPC, but cannot prove the connected player controls it, because the sandbox exposes no signer; career standings inherit that gap. An RPC outage blocks the SDK's picker for new players, though anyone mid-match keeps playing. Audio and motion preferences reset on reload, because the sandbox's opaque origin makes `localStorage` throw. A restart ends matches in progress. [Full list](https://github.com/Arithmos111/rarefriends_spyvsspy/blob/REPLACE_SHA/games/rare-agency/README.md#known-issues-and-capability-gaps).

**Credits. There are no third-party image, font or audio assets.** All embassy artwork is drawn procedurally on a canvas and all audio is synthesised at runtime with Web Audio; the SDK's sound kit covers economy actions. Rare Friend sprites are the canonical on-chain artwork through the SDK's sprite reader at 5× integer scale in an 80 × 80 box, white halo over black mask, never rotated, stretched, smoothed, recoloured or regenerated; Colossus Friends use the SDK's horizontal fallback.

No trading, wearable NFTs, creator fees or live economy is included. **Token Activity metrics are not claimed.** Production publication needs separate Rare Friends review.
