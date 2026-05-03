import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sha256FileHex } from '../src/utilities';

describe('Sha256FileHex', () => {
    it('Sha256FileHex matches known digest', async () => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unity-cli-sha-'));
        const filePath = path.join(dir, 'sample.txt');
        await fs.promises.writeFile(filePath, 'hello', 'utf8');

        const hex = await Sha256FileHex(filePath);
        expect(hex).toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
        );

        await fs.promises.rm(dir, { recursive: true, force: true });
    });
});
