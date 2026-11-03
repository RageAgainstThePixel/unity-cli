import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { IsSharedRunnerIdentity } from '../dist/license-client.js';

describe('IsSharedRunnerIdentity', () => {
    const environment = process.env.RUNNER_ENVIRONMENT;
    const platform = process.platform;

    const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });

    afterEach(() => {
        if (environment === undefined) {
            delete process.env.RUNNER_ENVIRONMENT;
        } else {
            process.env.RUNNER_ENVIRONMENT = environment;
        }

        setPlatform(platform);
    });

    for (const [runner, os, expected] of [
        ['github-hosted', 'darwin', true],
        ['github-hosted', 'linux', true],
        ['github-hosted', 'win32', false],
        ['self-hosted', 'darwin', false],
        [undefined, 'linux', false],
    ] as const) {
        it(`${runner} on ${os} is ${expected}`, () => {
            if (runner === undefined) {
                delete process.env.RUNNER_ENVIRONMENT;
            } else {
                process.env.RUNNER_ENVIRONMENT = runner;
            }

            setPlatform(os);
            assert.equal(IsSharedRunnerIdentity(), expected);
        });
    }
});
