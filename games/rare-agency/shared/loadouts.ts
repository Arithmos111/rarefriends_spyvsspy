/**
 * Gadget kits. Each kit is one outcome of the FriendSDK chance game defined in game.json,
 * except the free Field Issue kit every agent starts with so that owning no kit never
 * blocks play. Kit index N here corresponds to outcome ID N in game.json.
 */
import { TRAP_TYPES, type TrapType } from "./protocol.ts";

export type Kit = Readonly<{
  id: string;
  /** One-based FriendSDK outcome ID, or null for the free starter kit. */
  outcomeId: number | null;
  name: string;
  blurb: string;
  traps: Readonly<Record<TrapType, number>>;
  detector: boolean;
  lockpick: boolean;
  disarm: boolean;
}>;

const kit = (
  id: string, outcomeId: number | null, name: string, blurb: string,
  bomb: number, spring: number, bucket: number,
  extras: { detector?: boolean; lockpick?: boolean; disarm?: boolean } = {},
): Kit => Object.freeze({
  id, outcomeId, name, blurb,
  traps: Object.freeze({ bomb, spring, bucket }),
  detector: extras.detector ?? false,
  lockpick: extras.lockpick ?? false,
  disarm: extras.disarm ?? false,
});

export const FIELD_KIT_ID = "field";

export const KITS: readonly Kit[] = Object.freeze([
  kit(FIELD_KIT_ID, null, "Field Issue",
    "Standard embassy issue. Always available, never consumed.", 2, 1, 0),
  kit("standard", 1, "Standard Issue Kit",
    "A balanced spread of traps for a careful agent.", 2, 2, 1),
  kit("demolition", 2, "Demolition Kit",
    "Heavy on letter bombs. Make the furniture dangerous.", 4, 2, 1),
  kit("counter", 3, "Counter-Intel Kit",
    "Carries a trap detector so rival traps light up in your room.", 2, 2, 2, { detector: true }),
  kit("ghost", 4, "Ghost Kit",
    "Detector plus lockpick: see traps and search furniture far faster.", 3, 2, 2, { detector: true, lockpick: true }),
  kit("director", 5, "Director's Kit",
    "Full loadout with a disarm tool for stripping rival traps.", 4, 3, 3, { detector: true, lockpick: true, disarm: true }),
]);

const BY_ID = new Map(KITS.map(entry => [entry.id, entry]));
const BY_OUTCOME = new Map(KITS.filter(entry => entry.outcomeId !== null).map(entry => [entry.outcomeId!, entry]));

export function kitById(id: string): Kit {
  return BY_ID.get(id) ?? KITS[0];
}
export function kitByOutcomeId(outcomeId: number): Kit | null {
  return BY_OUTCOME.get(outcomeId) ?? null;
}
export function isKnownKit(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/** Rare Friends Genesis holders carry one extra letter bomb. Cosmetic badge aside, this is the only perk. */
export const GENESIS_BONUS_TRAP: TrapType = "bomb";
export const GENESIS_BONUS_COUNT = 1;

export function resolveTraps(kitId: string, genesis: boolean): Record<TrapType, number> {
  const source = kitById(kitId).traps;
  const traps = Object.fromEntries(TRAP_TYPES.map(type => [type, source[type]])) as Record<TrapType, number>;
  if (genesis) traps[GENESIS_BONUS_TRAP] += GENESIS_BONUS_COUNT;
  return traps;
}
