# FriendSDK feedback from building The Rare Agency

Written while building and deploying a live multiplayer entry, originally against FriendSDK
v0.1.0 (commit `da4828f8`). None of these can be worked around from inside a game.

**The first one is already fixed.** This entry now runs on v0.1.2, which resolves it; it is
kept here because it was found the hard way on a live deployment and the fix is worth
recording.

## A wrong-network wallet is indistinguishable from owning no Friends — fixed in v0.1.2

A wallet on the wrong chain is indistinguishable from owning no Friends. `GameHost` only runs `readOwnedFriends` once the wallet session reports chain 4663; on any other chain it never queries, yet the picker still renders "No playable Friends found" directly beneath the "Switch your wallet to Robinhood mainnet (4663)" alert. The definitive-sounding message is the one people act on, and this cost real debugging time while deploying this entry with six eligible Friends in the connected wallet. Suppressing the empty-list message while `wallet.status === "wrong-network"` would resolve it. A game cannot work around this, since the picker and the ownership gate are trusted runtime code that runs before the game component mounts. Relatedly, "hardwired" is load-bearing but easy to miss: a temporary, balance-dependent Friend with no permanent token-bound wallet is not eligible, and the picker does not distinguish it from a wrong-network result either.

**Resolved in v0.1.2.** `friendsEmptyMessage` is now suppressed unless discovery actually
succeeded, so the empty-list line no longer appears on the wrong chain. The alert names the
chain you are on, and a **Switch to Robinhood** button calls `session.switchNetwork()` for
you. Generation-0 holdings get their own message rather than being silently absent. Thank you.


## The Friend picker does not scale to a large collection

`GameFrame` renders the owned Friends as one flat `friends.map(...)` of text buttons, each showing only the label and "Hardwired Generations". Discovery itself is fine — `readOwnedFriends` supports up to 10,000 NFTs per account — but a wallet holding hundreds produces hundreds of identical, unordered, unsearchable buttons in a menu, with no artwork to tell them apart. Three changes would fix it, all in the runtime: render each Friend's sprite beside its label using the artwork routine the SDK already ships (`createFriendReader`/`spriteFrame`); add a filter box matching on token ID and label; and sort or pin by most recently selected, which the runtime could persist since it owns the selection. A game cannot do any of this: AGENTS.md forbids implementing "an ownership gate or another Friend selector in game code", and `GameHostProps` exposes no hook for an initial Friend, a sort order, or a custom row renderer. This entry shows the selected Friend's artwork at portrait scale on its own title screen, which is the nearest a game can get — after selection rather than during it.

## Capabilities this entry needed and worked around

Realtime multiplayer required a same-origin WebSocket, because the sandbox CSP allows `connect-src 'self'` and the Rare Friends RPC only; the relay therefore attaches to the SDK's own static server and leaves its CSP untouched, but this means the game cannot be hosted as pure static files. The relay cannot verify that a client controls the Friend ID it claims, since the sandbox exposes no signing; closing that needs a signed session attestation from the trusted runtime. Awarding RF for winning a match would need a contract that settles a skill-decided outcome, which the v0.1 chance-game contract does not model. Preview state is session-local, so kits do not persist between sessions.
