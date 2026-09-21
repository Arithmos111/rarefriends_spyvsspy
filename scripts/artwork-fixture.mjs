/**
 * The SDK's own sprite fixture, shared by every browser-driven script here.
 *
 * Friend artwork lives on chain and is read over the Rare Friends RPC. Checks and galleries
 * must not depend on that endpoint being reachable, so they serve the SDK's sample sprite
 * data instead — the same bytes the SDK's own runtime check uses.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionResult } from "viem";

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@rarefriends/friendsdk"))));

export const fixture = await import(
  pathToFileURL(path.join(sdkRoot, "scripts/check-runtime-browser.mjs")).href);

export const { FAMILIES_REGISTRY_ABI, GENERATION_SPRITE_MANIFEST } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/generation-sprites.js")).href);

const source = await readFile(path.join(sdkRoot, "examples/fishing/sample-sprites.ts"), "utf8");
const frames = [...source.split('"7730": decodeGenerationSprites')[1].split("]),")[0]
  .matchAll(/0x[0-9a-f]+n/g)].map(([word]) => BigInt(word.slice(0, -1)));

/** Answer a Generations artwork call with the sample sprite. */
export function artworkCall(call) {
  const { functionName, args } = decodeFunctionData({ abi: FAMILIES_REGISTRY_ABI, data: call.data });
  const result = functionName === "familyOf" ? 5 : functionName === "seedOf" ? Number(args[0]) : frames;
  return encodeFunctionResult({ abi: FAMILIES_REGISTRY_ABI, functionName, result });
}

/**
 * Serve artwork reads on a page that talks to the RPC directly, rather than through the SDK
 * runtime. Used by the room gallery, which drives the renderer with no SDK frame around it.
 */
export async function routeArtwork(page) {
  await page.route(`${GENERATION_SPRITE_MANIFEST.rpcUrl}**`, async route => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const answer = value => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: value }),
    });
    if (body.method === "eth_chainId") {
      return answer(`0x${GENERATION_SPRITE_MANIFEST.chainId.toString(16)}`);
    }
    if (body.method === "eth_call") return answer(artworkCall(body.params[0]));
    if (body.method === "eth_blockNumber") return answer("0x1");
    return answer("0x");
  });
}
