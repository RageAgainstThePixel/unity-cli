import * as fs from 'fs';

const ELF_MAGIC = 0x464c457f; // "\x7fELF" read little-endian
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const PT_GNU_STACK = 0x6474e551;
const PF_X = 0x1;

/**
 * Clears the executable stack flag of a 64-bit little-endian ELF shared library, as `execstack -c` does.
 * glibc 2.41 and later refuse to dlopen a library that asks for an executable stack, which breaks the
 * Unity Licensing Client bundled with older editors (its libbindings.so) on Ubuntu 26.04.
 * @param filePath The library to patch.
 * @returns true when the flag was set and has been cleared, false when the file is not such a library or has no executable stack.
 */
export async function ClearExecutableStack(filePath: string): Promise<boolean> {
    const handle = await fs.promises.open(filePath, 'r+');

    try {
        const header = Buffer.alloc(64);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);

        if (bytesRead < header.length ||
            header.readUInt32LE(0) !== ELF_MAGIC ||
            header[4] !== ELFCLASS64 ||
            header[5] !== ELFDATA2LSB) {
            return false;
        }

        const phoff = Number(header.readBigUInt64LE(0x20));
        const phentsize = header.readUInt16LE(0x36);
        const phnum = header.readUInt16LE(0x38);

        if (phentsize < 8 || phnum === 0) {
            return false;
        }

        const table = Buffer.alloc(phentsize * phnum);
        const tableRead = await handle.read(table, 0, table.length, phoff);

        if (tableRead.bytesRead < table.length) {
            return false;
        }

        for (let i = 0; i < phnum; i++) {
            const entry = i * phentsize;

            if (table.readUInt32LE(entry) !== PT_GNU_STACK) {
                continue;
            }

            const flags = table.readUInt32LE(entry + 4);

            if ((flags & PF_X) === 0) {
                return false;
            }

            const patched = Buffer.alloc(4);
            patched.writeUInt32LE(flags & ~PF_X);
            await handle.write(patched, 0, 4, phoff + entry + 4);
            return true;
        }

        return false;
    } finally {
        await handle.close();
    }
}
