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
        expect(output).toMatch(/Usage|Help|Options/i);
    });

    it('should show version with --version', () => {
        const output = runCli('--version');
        expect(output).toMatch(/\d+\.\d+\.\d+/);
    });

    // Add more tests for each CLI option as implemented
    // Example:
    // it('should handle --some-option', () => {
    //   const output = runCli('--some-option');
    //   expect(output).toContain('expected output');
    // });
});
