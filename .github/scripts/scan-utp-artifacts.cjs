/**
 * CI / local maintenance: scan *-utp-json.log trees and verify every object only uses
 * top-level keys that normalizeTelemetryEntry (UTP_SUPPORTED_TOP_LEVEL_PROPERTIES) recognizes.
 * Exits non-zero on JSON parse errors or unknown keys.
 *
 * Kept as CommonJS so `node .github/scripts/scan-utp-artifacts.cjs` can require `dist/utp.js`
 * after `npm run build` without ts-node or compiling this file.
 *
 * Usage: node .github/scripts/scan-utp-artifacts.cjs [directory]
 * Default directory: $GITHUB_WORKSPACE/utp-artifacts, else ./utp-artifacts
 */
const fs = require('fs');
const path = require('path');
const { normalizeTelemetryEntry } = require(path.join(__dirname, '..', '..', 'dist', 'utp.js'));

function defaultScanRoot() {
    if (process.argv[2]) {
        return process.argv[2];
    }
    if (process.env.GITHUB_WORKSPACE) {
        return path.join(process.env.GITHUB_WORKSPACE, 'utp-artifacts');
    }
    return path.join(process.cwd(), 'utp-artifacts');
}

const root = path.resolve(defaultScanRoot());
if (!fs.existsSync(root)) {
    console.warn(`scan-utp-artifacts: directory not found (skipping): ${root}`);
    process.exit(0);
}
if (!fs.statSync(root).isDirectory()) {
    console.warn(`scan-utp-artifacts: not a directory (skipping): ${root}`);
    process.exit(0);
}

const typeCount = new Map();
const unknownKeyOccurrences = new Map();
let totalObjects = 0;
const parseErrors = [];

function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p);
        } else if (e.name.endsWith('-utp-json.log')) {
            const raw = fs.readFileSync(p, 'utf8').trim();
            if (!raw) {
                continue;
            }
            let data;
            try {
                data = JSON.parse(raw);
            } catch (err) {
                parseErrors.push(`${path.relative(root, p)}: ${err.message}`);
                continue;
            }
            const arr = Array.isArray(data) ? data : [data];
            for (const o of arr) {
                if (!o || typeof o !== 'object') {
                    continue;
                }
                totalObjects++;
                const t = o.type ?? '(missing)';
                typeCount.set(t, (typeCount.get(t) || 0) + 1);
                const { unknownTopLevelKeys } = normalizeTelemetryEntry(o);
                for (const k of unknownTopLevelKeys) {
                    unknownKeyOccurrences.set(k, (unknownKeyOccurrences.get(k) || 0) + 1);
                }
            }
        }
    }
}

walk(root);

const out = {
    artifactRoot: root,
    totalObjects,
    types: Object.fromEntries([...typeCount.entries()].sort((a, b) => b[1] - a[1])),
    unknownTopLevelKeys: Object.fromEntries([...unknownKeyOccurrences.entries()].sort((a, b) => b[1] - a[1])),
    parseErrorCount: parseErrors.length,
    parseErrorsSample: parseErrors.slice(0, 50),
};
console.log(JSON.stringify(out, null, 2));

let code = 0;
if (parseErrors.length > 0) {
    console.error(`scan-utp-artifacts: ${parseErrors.length} JSON parse error(s)`);
    code = 1;
}
if (unknownKeyOccurrences.size > 0) {
    console.error(
        'scan-utp-artifacts: unknown top-level key(s) on UTP objects — extend UTP_SUPPORTED_TOP_LEVEL_PROPERTIES in src/utp.ts:',
        [...unknownKeyOccurrences.keys()].join(', ')
    );
    code = 1;
}
process.exit(code);
