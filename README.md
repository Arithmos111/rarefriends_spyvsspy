# Embassy Run

A four-player **Spy vs Spy–style** stealth game for the
[Rare Friends Vibeathon](https://github.com/spokesz/rarefriends-vibeathon), built on
[FriendSDK v0.1](https://github.com/spokesz/friendsdk).

Your Rare Friend is a spy inside a nine-room embassy. Four pieces of intelligence are hidden in
the furniture. Search for them, booby-trap the furniture and doorways behind you, and reach the
courtyard gate with the full set before your rivals do. Two to four agents share an embassy,
with matchmaking lobbies so dozens can play at once.

Agents have five health and start bare-handed. Hidden alongside the intelligence are medkits,
ballistic vests, and exactly one stiletto knife that doubles your damage and drops where its
carrier falls. Traps are live against whoever set them, so remember where you left that letter
bomb. Every finished match feeds a career leaderboard kept per Rare Friend, and you can give
your Friend a name that shows in parentheses after your codename.

The game rules, controls, exact economy and known issues are in
**[games/embassy-run/README.md](games/embassy-run/README.md)**.

The vibeathon entry is drafted at
[submissions/embassy-run/README.md](submissions/embassy-run/README.md), at the same path the
submission pull request needs. Its four source links carry a `REPLACE_SHA` placeholder to be
filled with the submitted commit.

## Play it

Needs **Node.js 22+**, npm and git, plus a browser wallet holding a hardwired Rare
Friends Generations NFT (generation 1 or higher) on Robinhood mainnet, chain 4663.

The game opens on a title screen showing your own Friend at portrait scale, with a **Training
run** beside it: a nine-step walkthrough of every control that runs entirely in the browser
against the real simulation, needing no relay, no lobby and no second player.

> **Switch your wallet to Robinhood mainnet (chain 4663) before connecting.** On any other
> network the SDK never queries your holdings, yet still reports "No playable Friends found",
> which reads like you own nothing. If you hold Friends and the game says you do not, check
> the network first. See [known issues](games/embassy-run/README.md#known-issues-and-capability-gaps).

```sh
npm run setup
npm run dev
```

`setup` clones FriendSDK at a pinned commit into `vendor/`, builds it, packs it and
installs it. The SDK is published UNLICENSED, so this repository fetches it rather
than redistributing it. `dev` prints a local URL and a LAN URL — open the LAN one on
a phone on the same wifi, or the same URL in a second browser, to play against
yourself.

Connect your wallet, pick your Friend, then **Quick match**, **Create** a lobby, or
join one by its four-character code.

```sh
npm run build   # static bundle into .build/game
npm start       # serve that bundle with the relay
```

Set `PORT` and `HOST`, or pass `--port` and `--host`, to change where it listens.

## Deploying it

Full instructions, including troubleshooting, are in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

**On a VPS (Hostinger, Hetzner, DigitalOcean, anything with Docker).** A Compose stack runs the
game behind Caddy, which obtains and renews certificates on its own:

```sh
cp .env.example .env    # set DOMAIN to a hostname already pointing at the machine
docker compose up -d --build
```

**On Fly.io.** `fly.toml` and the `Dockerfile` are ready:

```sh
fly launch --no-deploy --copy-config   # pick your own app name
fly deploy
```

**What the host must provide.** Node.js 22.18 or newer, because the server imports the shared
simulation as TypeScript and relies on Node's native type stripping. A long-lived process, not
serverless, because the connection is a WebSocket and match state lives in memory. TLS on a
real domain, because browser wallets need a secure context and a bare IP will not do. WebSocket
passthrough on any proxy in front. Outbound HTTPS to the Rare Friends RPC, which degrades
gracefully to "no Genesis perk" if blocked. No database.

**Shared web hosting will not work,** even where it advertises Node.js support. Per-account
connection limits and resource controls throttle exactly the pattern this uses, one long-lived
socket per player.

**The static files cannot live on a separate CDN origin.** The SDK's sandbox allows
`connect-src 'self'`, so the WebSocket must share an origin with the game document. One origin
serves both, or nothing connects. That rules out GitHub Pages entirely, including the
"static on Pages, relay elsewhere" split. `npm run check:proxy` guards this by driving a real
browser through a reverse proxy in the production shape.

**Run exactly one instance.** Lobbies and matches are in-process, so a second instance serves a
second, disconnected lobby list. Scale the machine up, not out. Scaling out later needs sticky
routing by lobby code, or moving state to Redis.

**Sizing, measured rather than estimated.** Load-tested with synthetic clients speaking the real
protocol against the real relay:

| Load | CPU | Memory | Downstream |
| --- | --- | --- | --- |
| 40 players, 10 matches | 7.6% of one core | 124 MB | 1.25 MB/s |
| 120 players, 30 matches | 14% of one core | 151 MB | 3.7 MB/s |

Snapshot delivery held at 19.7 Hz against a 20 Hz target at 120 players. One shared vCPU with
512 MB to 1 GB covers that comfortably. Bandwidth is the binding constraint, not CPU: each
player pulls about 32 KiB/s, so 100 concurrent players for an hour is roughly 11 GB. If that
ever matters, the lever is the snapshot, which is about 1.6 KB and currently resends static
furniture and the full scoreboard every tick.

Set `RF_GENESIS_ADDRESS` to switch on the Genesis perk once that contract address is available.

## How it fits together

FriendSDK runs a game component inside a sandboxed 960×640 iframe whose
Content-Security-Policy allows `connect-src 'self'` and the Rare Friends RPC, and
nothing else. That single line decides the architecture: realtime multiplayer is only
possible over a **same-origin** WebSocket.

So the relay attaches to the SDK's own static server instead of replacing it. The
SDK's bundler, sandbox document, CSP and generated-files-only serving policy are used
exactly as shipped; the only addition is an upgrade handler on `/relay`.

```
scripts/host.mjs        reuses the SDK's buildGame + createGameServer, attaches the relay
server/relay.mjs        lobbies, matchmaking, and one authoritative match loop at 20 Hz
server/rpc.mjs          read-only ownerOf / balanceOf, for real-token checks and the Genesis perk
games/embassy-run/
  index.tsx             the game component the SDK mounts
  render.ts             isometric canvas renderer, canonical Friend sprites
  net.ts                same-origin relay client with reconnect
  shared/               protocol, map, kits and the simulation — imported by BOTH sides
  game.json             the chance-game definition (crate price and kit odds)
```

`shared/` is the important part. The browser bundles those TypeScript files through
esbuild and the server imports the *same files* using Node 22's native type stripping,
so client-side movement prediction runs the exact code the server uses to correct it.
There is one simulation, not two.

The server is authoritative for everything that decides an outcome, and snapshots are
scoped to the room a player is standing in, so a modified client cannot see items,
traps or agents elsewhere in the embassy.

## Access

Play requires a **Generations** NFT, verified by the SDK runtime's fresh
`readGenerationEligibility` check before the game mounts. This component never
connects a wallet, enumerates token IDs, or implements its own gate.

**Genesis** holders get a perk rather than a separate door: the relay reads the owner
of the selected Friend and checks their Genesis balance, granting an extra letter bomb
and a GENESIS badge. FriendSDK v0.1 publishes no Genesis contract address, so set
`RF_GENESIS_ADDRESS` to switch the perk on; without it every agent is treated as a
non-holder.

## Checks

```sh
npm run check      # typecheck, unit tests, game validation and the browser check
```

| Command | What it covers |
| --- | --- |
| `npm run typecheck` | TypeScript across the game and shared simulation |
| `npm test` | 23 simulation tests: determinism, doorways, searching, traps, combat, drops, escaping, the timer, client/server agreement, and furniture reachability |
| `npm run check:game` | Mirrors the SDK's own game validation: definition parses, weights total 10,000 bps, expected reward below price, no wallet transport in game code, no sources outside the game or SDK |
| `npm run check:browser` | Drives two real browsers through the SDK ownership gate, buys and opens a crate, creates and joins a lobby, plays a live match, and asserts the SDK container bounds hold at desktop and phone widths |
| `npm run check:proxy` | Stands up the production shape, a reverse proxy in front of the app, and confirms the sandboxed frame still reaches the relay through it |

`npm run screenshots` captures reference images of each screen into `.build/shots`.

Browser checks use the SDK's own internal identity fixture, which is what AGENTS.md
reserves mock identities for. Nothing else in this repository mocks identity.

## Scope

Purchases, crates, kits and redemptions are **simulated** by the SDK's preview client
and labelled as such in the UI. No contract is deployed, no transaction is sent and no
private key is involved. Wallet connection and read-only ownership checks are the only
chain access, and they are the SDK's.

Capability gaps and known issues are listed in
[games/embassy-run/README.md](games/embassy-run/README.md#known-issues-and-capability-gaps).

## Credits

Embassy artwork is drawn procedurally on a canvas; there are no third-party image,
font or audio assets. Rare Friend sprites are the canonical on-chain artwork read
through FriendSDK and never modified. Sounds come from the SDK's sound kit.
