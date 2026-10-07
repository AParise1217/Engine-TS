import { execFileSync } from 'child_process';
import { describe, expect, test } from 'bun:test';

describe('entity module circular-import guard', () => {
    // Player.ts, NetworkPlayer.ts, PathingEntity.ts, and Npc.ts form a real
    // import cycle (subclasses importing their own base, and vice versa, for
    // instanceof checks -- see isPlayer()/isNpc() on Entity). This only
    // breaks on a *cold* module graph load, so it has to run in a fresh
    // process -- any module already loaded by this test file's own imports
    // would mask the bug. If this throws, something re-added a value-level
    // import of a subclass into one of its own base classes.
    test('Player.ts loads cleanly in a fresh process', () => {
        // Importing World.ts (which Player.ts does) schedules the tick loop,
        // so the process won't exit on its own -- exit explicitly once the
        // import itself has resolved without throwing, which is all this
        // guards against.
        expect(() => {
            execFileSync('bun', ['--eval', "import '#/engine/entity/Player.js'; process.exit(0);"], { cwd: process.cwd(), stdio: 'pipe' });
        }).not.toThrow();
    });
});
