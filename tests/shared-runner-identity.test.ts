import { IsSharedRunnerIdentity } from '../src/license-client';

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

    it.each([
        ['github-hosted', 'darwin', true],
        ['github-hosted', 'linux', true],
        ['github-hosted', 'win32', false],
        ['self-hosted', 'darwin', false],
        [undefined, 'linux', false],
    ] as const)('%s on %s is %s', (runner, os, expected) => {
        if (runner === undefined) {
            delete process.env.RUNNER_ENVIRONMENT;
        } else {
            process.env.RUNNER_ENVIRONMENT = runner;
        }

        setPlatform(os);
        expect(IsSharedRunnerIdentity()).toBe(expected);
    });
});
