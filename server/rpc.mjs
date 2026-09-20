/**
 * Minimal read-only JSON-RPC against Robinhood mainnet.
 *
 * Two calls only: ownerOf on the Generations collection to confirm a claimed Friend is a
 * real token and learn its owner, and balanceOf on Rare Friends Genesis to decide the
 * Genesis perk. No signing, no private key, no writes.
 */
const RPC_URL = process.env.RF_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const GENERATIONS_ADDRESS = process.env.RF_GENERATIONS_ADDRESS ?? "0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D";
/** Rare Friends Genesis is not published in FriendSDK v0.1; supply it to enable the perk. */
export const GENESIS_ADDRESS = process.env.RF_GENESIS_ADDRESS ?? null;

const SELECTOR_OWNER_OF = "0x6352211e";
const SELECTOR_BALANCE_OF = "0x70a08231";
const TIMEOUT_MS = Number(process.env.RF_RPC_TIMEOUT_MS ?? 6000);

const pad = value => value.replace(/^0x/, "").padStart(64, "0");
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

let rpcHealthy = true;
export const rpcAvailable = () => rpcHealthy;

async function ethCall(to, data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    rpcHealthy = true;
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the owner address, or null when the token does not exist or the RPC is unreachable. */
export async function ownerOfFriend(tokenId) {
  const key = `owner:${tokenId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const result = await ethCall(GENERATIONS_ADDRESS, SELECTOR_OWNER_OF + pad(BigInt(tokenId).toString(16)));
    const owner = result && result.length >= 66 ? `0x${result.slice(-40)}` : null;
    const value = owner && !/^0x0+$/.test(owner) ? owner : null;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    rpcHealthy = false;
    return null;
  }
}

/** Returns true only on a positive confirmed balance. Any failure means no perk. */
export async function holdsGenesis(owner) {
  if (!GENESIS_ADDRESS || !owner) return false;
  const key = `genesis:${owner.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const result = await ethCall(GENESIS_ADDRESS, SELECTOR_BALANCE_OF + pad(owner));
    const value = BigInt(result ?? "0x0") > 0n;
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    rpcHealthy = false;
    return false;
  }
}

export function rpcConfigSummary() {
  return {
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    generations: GENERATIONS_ADDRESS,
    genesis: GENESIS_ADDRESS,
    genesisPerkEnabled: Boolean(GENESIS_ADDRESS),
  };
}
