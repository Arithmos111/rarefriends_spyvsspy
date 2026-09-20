# Embassy Run

A four-player **Spy vs Spy–style** stealth game for the
[Rare Friends Vibeathon](https://github.com/spokesz/rarefriends-vibeathon), built on
[FriendSDK v0.1](https://github.com/spokesz/friendsdk).

Your Rare Friend is a spy inside a nine-room embassy. Four pieces of intelligence are
hidden in the furniture. Search for them, booby-trap the furniture behind you, and
reach the courtyard gate with the full set before your rivals do. Two to four agents
share an embassy, with matchmaking lobbies so dozens can play at once.

The game rules, controls, exact economy and known issues are in
**[games/embassy-run/README.md](games/embassy-run/README.md)**.

## Play it

Needs **Node.js 22+**, npm and git, plus a browser wallet holding a hardwired Rare
Friends Generations NFT (generation 1 or higher) on Robinhood mainnet, chain 4663.

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
| `npm test` | 21 simulation tests: determinism, doors, searching, traps, combat, drops, escaping, the timer, and client/server agreement |
| `npm run check:game` | Mirrors the SDK's own game validation: definition parses, weights total 10,000 bps, expected reward below price, no wallet transport in game code, no sources outside the game or SDK |
| `npm run check:browser` | Drives two real browsers through the SDK ownership gate, buys and opens a crate, creates and joins a lobby, plays a live match, and asserts the SDK container bounds hold at desktop and phone widths |

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
