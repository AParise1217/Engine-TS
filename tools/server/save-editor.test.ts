import { execFileSync } from 'child_process';
import { describe, expect, test } from 'bun:test';
import { loadAllConfigs, assertConfigsLoaded } from '#tools/server/save-editor.js';

describe('save-editor config guard', () => {
    test('assertConfigsLoaded() throws in a fresh process that never called loadAllConfigs()', () => {
        // Runs in a brand new process so process-wide static config state from
        // this test file (or any other) can't mask the bug this guards against.
        expect(() => {
            execFileSync('bun', ['--eval', "import { assertConfigsLoaded } from '#tools/server/save-editor.js'; assertConfigsLoaded();"], { cwd: process.cwd(), stdio: 'pipe' });
        }).toThrow();
    });

    test('loadAllConfigs() leaves every guarded config with a positive count', () => {
        loadAllConfigs('data/pack');
        expect(() => assertConfigsLoaded()).not.toThrow();
    });
});
