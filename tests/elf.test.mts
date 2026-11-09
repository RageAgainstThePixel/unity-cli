import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClearExecutableStack } from '../dist/elf.js';

const PT_LOAD = 1;
const PT_GNU_STACK = 0x6474e551;
const PHOFF = 64;
const PHENTSIZE = 56;

/** Builds a minimal 64-bit little-endian ELF image with the given program headers. */
function elf(headers: Array<{ type: number; flags: number }>, elfClass: number = 2): Buffer {
    const image = Buffer.alloc(PHOFF + PHENTSIZE * headers.length);
    image.writeUInt32LE(0x464c457f, 0);
    image[4] = elfClass;
    image[5] = 1;
    image.writeBigUInt64LE(BigInt(PHOFF), 0x20);
    image.writeUInt16LE(PHENTSIZE, 0x36);
    image.writeUInt16LE(headers.length, 0x38);
    headers.forEach((header, i) => {
        image.writeUInt32LE(header.type, PHOFF + i * PHENTSIZE);
        image.writeUInt32LE(header.flags, PHOFF + i * PHENTSIZE + 4);
    });
    return image;
}

const stackFlags = (file: string, index: number) => fs.readFileSync(file).readUInt32LE(PHOFF + index * PHENTSIZE + 4);

describe('ClearExecutableStack', () => {
    let dir: string;

    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('clears only the execute bit of an executable stack', async () => {
        const file = path.join(dir, 'libbindings.so');
        fs.writeFileSync(file, elf([{ type: PT_LOAD, flags: 0x5 }, { type: PT_GNU_STACK, flags: 0x7 }]));
        assert.equal(await ClearExecutableStack(file), true);
        assert.equal(stackFlags(file, 1), 0x6);
        assert.equal(stackFlags(file, 0), 0x5);
        assert.equal(await ClearExecutableStack(file), false);
    });

    it('leaves a non-executable stack alone', async () => {
        const file = path.join(dir, 'libok.so');
        fs.writeFileSync(file, elf([{ type: PT_GNU_STACK, flags: 0x6 }]));
        const before = fs.readFileSync(file);
        assert.equal(await ClearExecutableStack(file), false);
        assert.deepEqual(fs.readFileSync(file), before);
    });

    it('ignores files that are not 64-bit ELF', async () => {
        const text = path.join(dir, 'notes.so');
        fs.writeFileSync(text, 'not an elf file, just text that is long enough to fill a header of sixty-four bytes');
        assert.equal(await ClearExecutableStack(text), false);

        const elf32 = path.join(dir, 'lib32.so');
        fs.writeFileSync(elf32, elf([{ type: PT_GNU_STACK, flags: 0x7 }], 1));
        assert.equal(await ClearExecutableStack(elf32), false);
        assert.equal(stackFlags(elf32, 0), 0x7);
    });
});
