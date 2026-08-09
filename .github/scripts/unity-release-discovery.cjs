/**
 * Weekly Unity release discovery: compare Releases API tips to CI matrix + canary pin.
 * Usage: node .github/scripts/unity-release-discovery.cjs
 * Env: GITHUB_STEP_SUMMARY (optional), OPEN_ISSUE=1 + GH_TOKEN/GITHUB_TOKEN to open/update drift issue.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const apiBase = 'https://services.api.unity.com/unity/editor/release/v1/releases';
const minors = ['6000.0', '6000.1', '6000.2', '6000.3', '6000.4', '6000.5', '6000.6', '6000.7'];
const ISSUE_TITLE = 'unity-release-drift: matrix / canary vs Unity Releases API';
const ISSUE_LABEL = 'unity-release-drift';

async function fetchLatest(versionPrefix) {
    const url = `${apiBase}?version=${encodeURIComponent(versionPrefix)}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Releases API ${res.status} for ${versionPrefix}`);
    }
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map(r => ({
        version: r.version,
        stream: r.stream,
        shortRevision: r.shortRevision,
        releaseDate: r.releaseDate,
    }));
}

function loadMatrixVersions() {
    const buildOptions = JSON.parse(
        fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-options.json'), 'utf8')
    );
    return buildOptions['unity-version'] || [];
}

function loadCanaryPin() {
    const yml = fs.readFileSync(
        path.join(repoRoot, '.github', 'workflows', 'unity-preview-canary.yml'),
        'utf8'
    );
    const version = (yml.match(/"unity-version":\s*"([^"]+)"/) || [])[1];
    const changeset = (yml.match(/"changeset":\s*"([^"]+)"/) || [])[1];
    const channel = (yml.match(/"channel":\s*"([^"]+)"/) || [])[1];
    return { version, changeset, channel };
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
    const canary = loadCanaryPin();
    const tips = [];

    for (const minor of minors) {
        try {
            const rows = await fetchLatest(minor);
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
    lines.push('### Preview canary pin');
    lines.push('');
    lines.push(`- version: \`${canary.version || 'n/a'}\``);
    lines.push(`- changeset: \`${canary.changeset || 'n/a'}\``);
    lines.push(`- channel: \`${canary.channel || 'n/a'}\``);
    lines.push('');
    lines.push('### API tips by minor');
    lines.push('');
    lines.push('| Minor | Tip version | Stream | Changeset |');
    lines.push('|-------|-------------|--------|-----------|');
    for (const row of tips) {
        if (!row.tip) {
            lines.push(`| ${row.minor} | _(error)_ | | ${row.error || ''} |`);
            continue;
        }
        lines.push(
            `| ${row.minor} | ${row.tip.version} | ${row.tip.stream} | ${row.tip.shortRevision} |`
        );
    }
    lines.push('');

    const drifts = [];
    const tip60006 = tips.find(t => t.minor === '6000.6')?.tip;
    if (tip60006 && canary.version && tip60006.version !== canary.version) {
        drifts.push(
            `Canary pin ${canary.version} is behind API tip ${tip60006.version} (${tip60006.stream}, ${tip60006.shortRevision}).`
        );
    }
    for (const row of tips) {
        if (!row.tip) continue;
        const stream = String(row.tip.stream || '').toUpperCase();
        if (stream !== 'LTS' && stream !== 'SUPPORTED') continue;
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
        lines.push('No matrix/canary drift detected against API tips.');
    } else {
        lines.push('### Drift');
        lines.push('');
        for (const d of drifts) {
            lines.push(`- ${d}`);
        }
    }

    const body = lines.join('\n');
    console.log(body);

    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
    }

    if (process.env.OPEN_ISSUE === '1' && drifts.length > 0) {
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        if (!token) {
            console.error('OPEN_ISSUE=1 but no GH_TOKEN/GITHUB_TOKEN');
            process.exitCode = 1;
            return;
        }
        try {
            const existing = execFileSync(
                'gh',
                ['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '5'],
                { encoding: 'utf8' }
            );
            const issues = JSON.parse(existing || '[]');
            const hit = issues.find(i => i.title === ISSUE_TITLE);
            const issueBody = [
                'Automated drift report from `unity-release-discovery`.',
                '',
                ...drifts.map(d => `- ${d}`),
                '',
                body,
            ].join('\n');
            try {
                execFileSync('gh', ['label', 'create', ISSUE_LABEL, '--force'], { stdio: 'ignore' });
            } catch {
                // label may already exist or lack permission; issue create can omit it
            }
            if (hit) {
                execFileSync('gh', ['issue', 'comment', String(hit.number), '--body', issueBody], {
                    stdio: 'inherit',
                });
                console.log(`Updated issue #${hit.number}`);
            } else {
                try {
                    execFileSync(
                        'gh',
                        ['issue', 'create', '--title', ISSUE_TITLE, '--label', ISSUE_LABEL, '--body', issueBody],
                        { stdio: 'inherit' }
                    );
                } catch {
                    execFileSync(
                        'gh',
                        ['issue', 'create', '--title', ISSUE_TITLE, '--body', issueBody],
                        { stdio: 'inherit' }
                    );
                }
            }
        } catch (err) {
            console.error(`Issue upsert failed: ${err.message || err}`);
            process.exitCode = 1;
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
