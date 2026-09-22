/**
 * The Genesis perk's configuration, which is easy to disable by accident.
 *
 * The address is carried in the repository rather than supplied by FriendSDK, and an empty
 * RF_GENESIS_ADDRESS deliberately means "switch the perk off". Docker Compose's usual
 * `${VAR:-}` idiom expands to exactly that empty string, so the default deployment would
 * have silently turned the perk off. These pin the three states apart.
 */
import test from "node:test";
import assert from "node:assert/strict";

/** Load a fresh copy of the module under a given environment. */
async function loadRpc(genesis) {
  const previous = process.env.RF_GENESIS_ADDRESS;
  if (genesis === undefined) delete process.env.RF_GENESIS_ADDRESS;
  else process.env.RF_GENESIS_ADDRESS = genesis;
  try {
    return await import(`../server/rpc.mjs?case=${encodeURIComponent(String(genesis))}`);
  } finally {
    if (previous === undefined) delete process.env.RF_GENESIS_ADDRESS;
    else process.env.RF_GENESIS_ADDRESS = previous;
  }
}

test("the Genesis perk is on by default, with the address carried in the repository", async () => {
  const rpc = await loadRpc(undefined);
  assert.match(rpc.GENESIS_ADDRESS ?? "", /^0x[0-9a-fA-F]{40}$/,
    "an unset RF_GENESIS_ADDRESS should fall back to a real address");
  assert.equal(rpc.rpcConfigSummary().genesisPerkEnabled, true);
});

test("an explicit address overrides the built-in one", async () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const rpc = await loadRpc(address);
  assert.equal(rpc.GENESIS_ADDRESS, address);
  assert.equal(rpc.rpcConfigSummary().genesisPerkEnabled, true);
});

test("an empty address switches the perk off rather than falling back", async () => {
  const rpc = await loadRpc("");
  assert.equal(rpc.GENESIS_ADDRESS, null,
    "an empty value is the documented way to disable the perk");
  assert.equal(rpc.rpcConfigSummary().genesisPerkEnabled, false);
});

test("holdsGenesis reports no perk when the perk is switched off", async () => {
  const rpc = await loadRpc("");
  assert.equal(await rpc.holdsGenesis("0x1111111111111111111111111111111111111111"), false);
});

test("the Generations collection is the canonical one", async () => {
  const rpc = await loadRpc(undefined);
  assert.equal(rpc.GENERATIONS_ADDRESS.toLowerCase(),
    "0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d");
  assert.equal(rpc.CHAIN_ID, 4663);
});
