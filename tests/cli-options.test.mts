import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { execSync } from 'child_process';

describe('unity-cli CLI options', () => {
    const runCli = (args: string) => {
        try {
            return execSync(`unity-cli ${args}`, { encoding: 'utf-8' });
        } catch (error: any) {
            return error.stdout || error.message;
        }
    };

    it('should show help with --help', () => {
        const output = runCli('--help');
        assert.match(output, /Usage|Help|Options/i);
    });

    it('should show version with --version', () => {
        const output = runCli('--version');
        assert.match(output, /\d+\.\d+\.\d+/);
    });

    // Add more tests for each CLI option as implemented
    // Example:
    // it('should handle --some-option', () => {
    //   const output = runCli('--some-option');
    //   assert.ok(output.includes('expected output'));
    // });
});
