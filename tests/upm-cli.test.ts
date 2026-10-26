import * as path from 'path';
import * as os from 'os';
import { UpmCli } from '../src/upm-cli';

describe('UpmCli', () => {
    it('managedRoot is under home', () => {
        const upm = new UpmCli();
        expect(upm.managedRoot).toBe(path.join(os.homedir(), '.unity-cli', 'upm'));
    });

    it('IsUpdateAvailable is true when nothing is installed', () => {
        const spy = jest.spyOn(UpmCli.prototype, 'GetInstalledReleaseTag');
        spy.mockReturnValue(undefined);
        try {
            const upm = new UpmCli();
            expect(upm.IsUpdateAvailable('v9.27.0')).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    it('IsUpdateAvailable compares release tags when a release is recorded', () => {
        const spy = jest.spyOn(UpmCli.prototype, 'GetInstalledReleaseTag');
        spy.mockReturnValue('v9.28.0');
        try {
            const upm = new UpmCli();
            expect(upm.IsUpdateAvailable('v9.29.0')).toBe(true);
            expect(upm.IsUpdateAvailable('v9.28.0')).toBe(false);
            expect(upm.IsUpdateAvailable('v9.27.0')).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });
});
