import { describe, expect, test } from 'bun:test';
import { toSafeName } from '#/util/JString.js';
import { CHARACTER_POOL, jitterOffset, pickUnusedCharacter, rollSlotCount } from '#/engine/BotPool.js';

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
