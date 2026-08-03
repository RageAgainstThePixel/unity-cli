/**
 * CI helper: parse a *-utp-json.log (pretty JSON array from unity-cli, or NDJSON fixtures)
 * through normalizeTelemetryEntry so benign elevated severities are remapped, then exit 0
 * if any remaining severity is in the requested set.
 *
 * Usage: node utp-file-has-actionable-severity.cjs <file> [Error|Exception|Assert]
 * Exit 0 = has actionable severity; exit 1 = none; exit 2 = usage/IO/parse error.
 *
 * Requires `npm run build` so dist/utp.js exists (same as scan-utp-artifacts.cjs).
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const distUtp = path.join(repoRoot, 'dist', 'utp.js');
if (!fs.existsSync(distUtp)) {
    console.error(`utp-file-has-actionable-severity: missing ${distUtp} (run npm run build)`);
    process.exit(2);
}

const { normalizeTelemetryEntry } = require(distUtp);

const filePath = process.argv[2];
const severitiesArg = process.argv[3] || 'Error|Exception|Assert';
if (!filePath) {
    console.error('Usage: node utp-file-has-actionable-severity.cjs <file> [Error|Exception|Assert]');
    process.exit(2);
}

const severitySet = new Set(severitiesArg.split('|').map(s => s.trim()).filter(Boolean));

function loadEntries(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return [];
    }
    try {
        const data = JSON.parse(trimmed);
        return Array.isArray(data) ? data : [data];
    } catch {
        // NDJSON / one compact object per line (contract fixtures)
        const out = [];
        for (const line of trimmed.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) {
                continue;
            }
            out.push(JSON.parse(t));
        }
        return out;
    }
}

let entries;
try {
    entries = loadEntries(fs.readFileSync(filePath, 'utf8'));
} catch (err) {
    console.error(`utp-file-has-actionable-severity: ${err.message || err}`);
    process.exit(2);
}

for (const entry of entries) {
    const { utp } = normalizeTelemetryEntry(entry);
    if (utp && utp.severity && severitySet.has(String(utp.severity))) {
        process.exit(0);
    }
}

process.exit(1);
