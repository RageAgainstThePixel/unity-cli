/**
 * Weekly Unity release discovery: compare Releases API tips to the CI matrix.
 * Usage: node .github/scripts/unity-release-discovery.cjs
 * Env: GITHUB_STEP_SUMMARY (optional): the report is appended to the run summary, and drift is a warning annotation.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const apiBase = 'https://services.api.unity.com/unity/editor/release/v1/releases';
const minors = ['6000.0', '6000.1', '6000.2', '6000.3', '6000.4', '6000.5', '6000.6', '6000.7', '6000.8', '7000.0', '7000.1'];

async function fetchLatest(versionPrefix) {
    const url = `${apiBase}?version=${encodeURIComponent(versionPrefix)}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Releases API ${res.status} for ${versionPrefix}`);
    }
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    // the report is markdown in the run summary, so only fields rebuilt from validated parts reach it
    return results.map(normalizeRelease).filter(Boolean);
}

const STREAMS = { LTS: 'LTS', SUPPORTED: 'SUPPORTED', TECH: 'TECH', BETA: 'BETA', ALPHA: 'ALPHA' };
const CHANNELS = { a: 'a', b: 'b', c: 'c', f: 'f', p: 'p', x: 'x' };

function normalizeRelease(r) {
    const version = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})([abcfpx])(\d{1,3})$/.exec(String(r?.version ?? ''));
    const revision = /^[0-9a-f]{12}$/.exec(String(r?.shortRevision ?? ''));
    const stream = STREAMS[String(r?.stream ?? '').toUpperCase()] ?? 'OTHER';
    if (!version) return null;
    const [, major, minor, patch, channel, build] = version;
    return {
        version: `${Number(major)}.${Number(minor)}.${Number(patch)}${CHANNELS[channel]}${Number(build)}`,
        stream,
        shortRevision: revision ? revision[0] : '',
    };
}

function loadMatrixVersions() {
    const buildOptions = JSON.parse(
        fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-options.json'), 'utf8')
    );
    return buildOptions['unity-version'] || [];
}

function pickTip(rows, preferStreams) {
    for (const stream of preferStreams) {
        const hit = rows.find(r => String(r.stream).toUpperCase() === stream);
        if (hit) return hit;
    }
    return rows[0];
}

async function main() {
    const matrixVersions = loadMatrixVersions();
    const tips = [];

    for (const minor of minors) {
        try {
            const rows = await fetchLatest(minor);
            if (rows.length === 0) continue; // the stream has no release yet
            const tip = pickTip(rows, ['LTS', 'SUPPORTED', 'BETA', 'ALPHA']);
            tips.push({ minor, tip, count: rows.length });
        } catch (err) {
            tips.push({ minor, tip: null, error: err.message });
        }
    }

    const lines = [];
    lines.push('## Unity release discovery');
    lines.push('');
    lines.push('### Blocking matrix (`build-options.json`)');
    lines.push('');
    for (const v of matrixVersions) {
        lines.push(`- \`${v}\``);
    }
    lines.push('');
    lines.push('### API tips by minor');
    lines.push('');
    lines.push('| Minor | Tip version | Stream | Changeset |');
    lines.push('|-------|-------------|--------|-----------|');
    for (const row of tips) {
        if (!row.tip) {
            lines.push(`| ${row.minor} | _(error)_ | | |`);
            continue;
        }
        lines.push(
            `| ${row.minor} | ${row.tip.version} | ${row.tip.stream} | ${row.tip.shortRevision} |`
        );
    }
    lines.push('');

    const drifts = [];
    // every stream is tracked, alphas and betas included: the matrix resolves each row to the newest build of its stream
    for (const row of tips) {
        if (!row.tip) continue;
        const stream = String(row.tip.stream || '').toUpperCase();
        const minorKey = row.minor; // e.g. 6000.5
        const covered = matrixVersions.some(v => {
            if (v === minorKey) return true;
            if (v.startsWith(minorKey + '.')) return true;
            if (v === `${minorKey}.x` || v === `${minorKey}.*`) return true;
            // 6000.0.x style
            const m = /^(\d+\.\d+)/.exec(v);
            return m && m[1] === minorKey;
        });
        if (!covered && !matrixVersions.includes(row.tip.version)) {
            drifts.push(
                `New ${stream} tip ${row.tip.version} for ${minorKey} is not represented in blocking matrix.`
            );
        }
    }

    if (drifts.length === 0) {
        lines.push('### Drift');
        lines.push('');
        lines.push('No matrix drift detected against API tips.');
    } else {
        lines.push('### Drift');
        lines.push('');
        for (const d of drifts) {
            lines.push(`- ${d}`);
        }
    }

    const body = lines.join('\n');
    console.log(body);

    // drift shows as a warning on the run; the report itself only goes to the run summary
    for (const d of drifts) {
        console.log(`::warning title=Unity release drift::${d}`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(path.resolve(process.env.GITHUB_STEP_SUMMARY), `${body}\n`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
