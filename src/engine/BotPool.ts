import { toSafeName } from '#/util/JString.js';

// Pregenerated pool of ambient-bot identities, drawn at spawn time by Bots.ts for any bot kind.
// Dependency-free on purpose -- Bots.ts (transitively) imports World.ts, whose module-level
// `export default new World()` (World.ts:2427) spawns real worker threads (login/friend/logger)
// the instant it's imported. Keeping this file out of that import chain is what makes
// `bun test src/engine/BotPool.test.ts` fast and side-effect-free.
export interface PoolCharacter {
    name: string;
    gender: number; // 0 = male, 1 = female -- Player.gender's own encoding
}

// ~32 entries, mixed gender, every name a valid RS2 base37 string (letters+digits, <=12 chars
// after toSafeName()). Add more here any time a new site needs more concurrent variety --
// CHARACTER_POOL.length is the only cap on how many bots can be active across every site near
// the player at once (see pickUnusedCharacter below). BotPool.test.ts's uniqueness check will
// catch an accidental base37 collision with an existing entry the moment one is added.
export const CHARACTER_POOL: PoolCharacter[] = [
    { name: 'Brom', gender: 0 },
    { name: 'Edric', gender: 0 },
    { name: 'Garrick', gender: 0 },
    { name: 'Hobb', gender: 0 },
    { name: 'Jorik', gender: 0 },
    { name: 'Lund', gender: 0 },
    { name: 'Morg', gender: 0 },
    { name: 'Oswin', gender: 0 },
    { name: 'Perrin', gender: 0 },
    { name: 'Quill', gender: 0 },
    { name: 'Rask', gender: 0 },
    { name: 'Soren', gender: 0 },
    { name: 'Tobin', gender: 0 },
    { name: 'Ulrik', gender: 0 },
    { name: 'Varrick', gender: 0 },
    { name: 'Wendel', gender: 0 },
    { name: 'Alda', gender: 1 },
    { name: 'Brenna', gender: 1 },
    { name: 'Cora', gender: 1 },
    { name: 'Dessa', gender: 1 },
    { name: 'Elin', gender: 1 },
    { name: 'Freya', gender: 1 },
    { name: 'Greta', gender: 1 },
    { name: 'Hilde', gender: 1 },
    { name: 'Ingrid', gender: 1 },
    { name: 'Junia', gender: 1 },
    { name: 'Katra', gender: 1 },
    { name: 'Lira', gender: 1 },
    { name: 'Mira', gender: 1 },
    { name: 'Nessa', gender: 1 },
    { name: 'Orla', gender: 1 },
    { name: 'Petra', gender: 1 }
];

export function randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

export function pickOne<T>(pool: T[]): T {
    return pool[Math.floor(Math.random() * pool.length)];
}

// Returns the first pool entry whose base37-normalized name isn't in `taken`, or null if every
// entry is taken. Deterministic (no randomness) -- the caller doesn't care which free name it
// gets, only that it's free, so pool order is as good a tie-break as any.
export function pickUnusedCharacter(pool: PoolCharacter[], taken: ReadonlySet<string>): PoolCharacter | null {
    for (const character of pool) {
        if (!taken.has(toSafeName(character.name))) {
            return character;
        }
    }
    return null;
}

// Random offset in [-tiles, tiles], inclusive both ends -- spreads multiple bot slots at one
// site so they don't stack on the exact same tile (CLAUDE.md's long-deferred "spawn-position
// jitter" backlog item, now needed since a site can hold more than one active bot).
export function jitterOffset(tiles: number): number {
    return randInt(-tiles, tiles);
}

// Random slot count in [0, max], inclusive -- 0 is a valid, intentional result: a site can roll
// "nobody's here this visit."
export function rollSlotCount(max: number): number {
    return randInt(0, max);
}

// idk.dat body-part ids grouped by IdkType.type (0..6 for one gender's 7 slots, 7..13 the same 7
// slots for the other gender) -- callers build this from the real IdkType cache (Bots.ts), this
// file just does the pure slot-math so it's testable without booting the engine.
export interface IdkPools {
    [type: number]: number[];
}

// Returns a random body-part id for the given slot (0-6) and gender (0 male, 1 female), or null
// if that slot has no pool entries -- the caller should leave the existing default in place
// rather than treat that as an error (a disabled/empty slot is a legitimate cache state).
export function pickIdkForSlot(pools: IdkPools, slot: number, gender: number): number | null {
    const type = slot + (gender === 1 ? 7 : 0);
    const pool = pools[type];
    if (!pool || pool.length === 0) {
        return null;
    }
    return pickOne(pool);
}

// Rolls one random value per [stat, min, max] triple -- used to give every ambient bot kind
// (not just the ones with a dedicated archetype roll) a varied, non-default level.
export function rollStatRanges(ranges: readonly (readonly [stat: number, min: number, max: number])[]): [stat: number, value: number][] {
    return ranges.map(([stat, min, max]) => [stat, randInt(min, max)]);
}

// Retries up to maxAttempts random jittered tiles against `isBlocked`, falling back to the exact
// anchor (homeX, homeZ) -- already assumed walkable, since every site is placed there deliberately
// -- if every jittered tile is blocked. `isBlocked` is injected so this stays pure/testable; Bots.ts
// wires it to the real collision map.
export function pickValidTile(homeX: number, homeZ: number, jitterTiles: number, maxAttempts: number, isBlocked: (x: number, z: number) => boolean): { x: number; z: number } {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const x = homeX + jitterOffset(jitterTiles);
        const z = homeZ + jitterOffset(jitterTiles);
        if (!isBlocked(x, z)) {
            return { x, z };
        }
    }
    return { x: homeX, z: homeZ };
}
