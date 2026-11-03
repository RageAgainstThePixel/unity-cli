import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import { UpmCli } from '../dist/upm-cli.js';

describe('UpmCli', () => {
    it('managedRoot is under home', () => {
        const upm = new UpmCli();
        assert.equal(upm.managedRoot, path.join(os.homedir(), '.unity-cli', 'upm'));
    });

    it('IsUpdateAvailable is true when nothing is installed', () => {
        const spy = mock.method(UpmCli.prototype, 'GetInstalledReleaseTag', () => undefined);
        try {
            const upm = new UpmCli();
            assert.equal(upm.IsUpdateAvailable('v9.27.0'), true);
        } finally {
            spy.mock.restore();
        }
    });

    it('IsUpdateAvailable compares release tags when a release is recorded', () => {
        const spy = mock.method(UpmCli.prototype, 'GetInstalledReleaseTag', () => 'v9.28.0');
        try {
            const upm = new UpmCli();
            assert.equal(upm.IsUpdateAvailable('v9.29.0'), true);
            assert.equal(upm.IsUpdateAvailable('v9.28.0'), false);
            assert.equal(upm.IsUpdateAvailable('v9.27.0'), false);
        } finally {
            spy.mock.restore();
        }
    });
});
