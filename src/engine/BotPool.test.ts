import { describe, expect, test } from 'bun:test';
import { toSafeName } from '#/util/JString.js';
import { CHARACTER_POOL, type IdkPools, jitterOffset, pickIdkForSlot, pickUnusedCharacter, pickValidTile, rollSlotCount, rollStatRanges } from '#/engine/BotPool.js';

describe('CHARACTER_POOL', () => {
    test('every name survives toSafeName() as a non-empty, <=12 char base37 string', () => {
        for (const character of CHARACTER_POOL) {
            const safe = toSafeName(character.name);
            expect(safe.length).toBeGreaterThan(0);
            expect(safe.length).toBeLessThanOrEqual(12);
        }
    });

    test('no two entries collide after base37 normalization', () => {
        const safeNames = CHARACTER_POOL.map(c => toSafeName(c.name));
        expect(new Set(safeNames).size).toBe(safeNames.length);
    });

    test('every entry has a valid gender (0 or 1)', () => {
        for (const character of CHARACTER_POOL) {
            expect([0, 1]).toContain(character.gender);
        }
    });

    test('pool has at least 30 entries -- the "long list" this feature was asked for', () => {
        expect(CHARACTER_POOL.length).toBeGreaterThanOrEqual(30);
    });
});

describe('pickUnusedCharacter', () => {
    test('returns the first entry when nothing is taken', () => {
        const result = pickUnusedCharacter(CHARACTER_POOL, new Set());
        expect(result).toBe(CHARACTER_POOL[0]);
    });

    test('skips taken names and returns the first free one', () => {
        const taken = new Set([toSafeName(CHARACTER_POOL[0].name), toSafeName(CHARACTER_POOL[1].name)]);
        const result = pickUnusedCharacter(CHARACTER_POOL, taken);
        expect(result).toBe(CHARACTER_POOL[2]);
    });

    test('returns null when every entry is taken', () => {
        const taken = new Set(CHARACTER_POOL.map(c => toSafeName(c.name)));
        const result = pickUnusedCharacter(CHARACTER_POOL, taken);
        expect(result).toBeNull();
    });
});

describe('rollSlotCount', () => {
    test('every roll is within [0, max] across many trials, and every value in range appears at least once', () => {
        const max = 3;
        const seen = new Set<number>();
        for (let i = 0; i < 2000; i++) {
            const roll = rollSlotCount(max);
            expect(roll).toBeGreaterThanOrEqual(0);
            expect(roll).toBeLessThanOrEqual(max);
            seen.add(roll);
        }
        expect(seen.size).toBe(max + 1); // 0, 1, 2, 3 all showed up
    });
});

describe('jitterOffset', () => {
    test('every offset is within [-tiles, tiles] across many trials, and both signs appear', () => {
        const tiles = 2;
        let sawNegative = false;
        let sawPositive = false;
        for (let i = 0; i < 2000; i++) {
            const offset = jitterOffset(tiles);
            expect(offset).toBeGreaterThanOrEqual(-tiles);
            expect(offset).toBeLessThanOrEqual(tiles);
            if (offset < 0) sawNegative = true;
            if (offset > 0) sawPositive = true;
        }
        expect(sawNegative).toBe(true);
        expect(sawPositive).toBe(true);
    });
});

// Guards the "every bot looked identical" bug (2026-10-05): randomizeAppearance() in Bots.ts
// draws from pools keyed by slot + gender*7, matching IdkSaveDesignHandler's real type mapping
// (male types 0-6, female types 7-13).
describe('pickIdkForSlot', () => {
    const pools: IdkPools = {
        0: [100, 101, 102], // male slot 0
        7: [200, 201] // female slot 0
    };

    test('draws from the male pool (type = slot) when gender is 0', () => {
        for (let i = 0; i < 50; i++) {
            expect(pools[0]).toContain(pickIdkForSlot(pools, 0, 0));
        }
    });

    test('draws from the female pool (type = slot + 7) when gender is 1', () => {
        for (let i = 0; i < 50; i++) {
            expect(pools[7]).toContain(pickIdkForSlot(pools, 0, 1));
        }
    });

    test('returns null for a slot with no pool entries, instead of throwing', () => {
        expect(pickIdkForSlot(pools, 3, 0)).toBeNull();
        expect(pickIdkForSlot({}, 0, 0)).toBeNull();
    });
});

// Guards the "every non-fighter bot sat at combat level 3" bug (2026-10-05).
describe('rollStatRanges', () => {
    test('rolls every stat within its own [min, max], preserving stat ids and order', () => {
        const ranges = [
            [1, 5, 20],
            [2, 1, 15],
            [3, 1, 15]
        ] as const;
        for (let i = 0; i < 500; i++) {
            const rolled = rollStatRanges(ranges);
            expect(rolled.length).toBe(ranges.length);
            for (let j = 0; j < ranges.length; j++) {
                const [stat, min, max] = ranges[j];
                const [rolledStat, value] = rolled[j];
                expect(rolledStat).toBe(stat);
                expect(value).toBeGreaterThanOrEqual(min);
                expect(value).toBeLessThanOrEqual(max);
            }
        }
    });

    test('an empty range list rolls nothing', () => {
        expect(rollStatRanges([])).toEqual([]);
    });
});

// Guards the "bot spawned one tile into an unwalkable obstacle" bug (2026-10-05, Brom inside the
// beehive enclosure) -- pickSpawnTile() in Bots.ts wires this to the real collision map.
describe('pickValidTile', () => {
    test('returns the first unblocked jittered tile it finds', () => {
        const result = pickValidTile(100, 200, 2, 5, () => false);
        expect(Math.abs(result.x - 100)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.z - 200)).toBeLessThanOrEqual(2);
    });

    test('falls back to the exact anchor tile when every attempt is blocked', () => {
        const result = pickValidTile(100, 200, 2, 5, () => true);
        expect(result).toEqual({ x: 100, z: 200 });
    });

    test('never calls isBlocked more than maxAttempts times', () => {
        let calls = 0;
        pickValidTile(100, 200, 2, 5, () => {
            calls++;
            return true;
        });
        expect(calls).toBe(5);
    });

    test('accepts a tile that only becomes unblocked on a later attempt', () => {
        let calls = 0;
        const result = pickValidTile(100, 200, 2, 5, () => {
            calls++;
            return calls < 3; // blocked, blocked, then open
        });
        expect(calls).toBe(3);
        expect(Math.abs(result.x - 100)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.z - 200)).toBeLessThanOrEqual(2);
    });
});
