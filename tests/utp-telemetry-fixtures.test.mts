import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
    normalizeTelemetryEntry,
    Severity,
    UTP_SUPPORTED_TOP_LEVEL_PROPERTIES,
} from '../dist/utp.js';
import { buildTestResultsTableMarkdown, utpToTestResultSummary } from '../dist/logging.js';
import { formatUtpUnrecognizedTopLevelPropertiesMessage } from '../dist/unity-logging.js';

const fixturesDir = path.join(import.meta.dirname, 'fixtures', 'utp');

function loadFixture(name: string): unknown[] {
    const p = path.join(fixturesDir, name);
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data : [data];
}

describe('UTP telemetry fixtures', () => {
    const fixtureFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));

    for (const fileName of fixtureFiles) {
        it(`${fileName} has only supported top-level keys and normalizes cleanly`, () => {
            for (const obj of loadFixture(fileName)) {
                const { utp, unknownTopLevelKeys } = normalizeTelemetryEntry(obj);
                assert.deepEqual(unknownTopLevelKeys, []);
                assert.notEqual(utp, undefined);
                for (const k of Object.keys(obj as object)) {
                    assert.equal(UTP_SUPPORTED_TOP_LEVEL_PROPERTIES.has(k), true);
                }
            }
        });
    }

    it('merges legacy stacktrace and file/line fields on Compiler', () => {
        const [first] = loadFixture('compiler-and-logentry.json');
        const { utp } = normalizeTelemetryEntry(first);
        assert.equal(utp.type, 'Compiler');
        assert.equal(utp.stackTrace, '');
        assert.equal(utp.file, 'Assets/UnityCliTests/CompilerErrors.cs');
        assert.equal(utp.fileName, 'Assets/UnityCliTests/CompilerErrors.cs');
        assert.equal(utp.line, 2);
        assert.equal(utp.lineNumber, 2);
    });

    it('maps TestStatus fixtures to summaries and markdown', () => {
        const rows = loadFixture('test-status.json').map(e => {
            const { utp } = normalizeTelemetryEntry(e);
            return utpToTestResultSummary(utp);
        });
        assert.equal(rows[0].status, '✅');
        assert.equal(rows[1].status, '❌');
        assert.equal(rows[2].status, '⏭️');
        assert.equal(rows[3].status, '◯');
        assert.equal(rows[1].durationMs, 5000);
        const md = buildTestResultsTableMarkdown(rows, 1024 * 1024, '');
        assert.ok(md.includes('### Test results'));
        assert.ok(md.includes('EditMode.Foo.Passes'));
    });

    it('reports unknown top-level keys without failing normalization', () => {
        const payload = {
            type: 'Compiler',
            version: 2,
            phase: 'Immediate',
            time: 1,
            processId: 1,
            severity: 'Warning',
            message: 'm',
            file: 'Assets/X.cs',
            line: 1,
            futureUnityOnlyField: 'surprise',
        };
        const { utp, unknownTopLevelKeys } = normalizeTelemetryEntry(payload);
        assert.deepEqual(unknownTopLevelKeys, ['futureUnityOnlyField']);
        assert.equal(utp.type, 'Compiler');
    });
});

describe('normalizeTelemetryEntry benign severity remaps', () => {
    it('remaps player-connection multicast Error to Info', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'Error',
            message: 'Unable to join player connection multicast group (err: 10013).',
        });
        assert.equal(utp.severity, Severity.Info);
    });

    it('remaps Socket bind failed / WSAEACCES permission Errors to Info', () => {
        const bind = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'Error',
            message:
                'Socket: bind failed, error: An attempt was made to access a socket in a way forbidden by its access permissions.',
        }).utp;
        assert.equal(bind.severity, Severity.Info);

        const plainExtracted = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Error,
            message: 'An attempt was made to access a socket in a way forbidden by its access permissions.',
        }).utp;
        assert.equal(plainExtracted.severity, Severity.Info);
    });

    it('remaps OpenCL and StackAllocator elevated severities to Info', () => {
        const opencl = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Error,
            message: 'Failed to find a suitable OpenCL device, baking cannot use GPU lightmapper.',
        }).utp;
        assert.equal(opencl.severity, Severity.Info);

        const stack = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Assert,
            message: '~StackAllocator(ALLOC_TEMP_MAIN) m_LastAlloc not NULL. Did you forget to call FreeAllStackAllocations()?',
        }).utp;
        assert.equal(stack.severity, Severity.Info);
    });

    it('leaves real Errors unchanged', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'Compiler',
            severity: 'Error',
            message: 'Assets/Foo.cs(1,1): error CS0001: boom',
        });
        assert.equal(utp.severity, Severity.Error);
    });

    it('canonicalizes severity casing', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'error',
            message: 'real failure',
        });
        assert.equal(utp.severity, Severity.Error);
    });
});

describe('formatUtpUnrecognizedTopLevelPropertiesMessage', () => {
    it('includes unknown key names and the full ##utp line', () => {
        const line = '##utp:{"type":"Action","extra":1}';
        const msg = formatUtpUnrecognizedTopLevelPropertiesMessage(['extra'], line);
        assert.ok(msg.includes('unrecognized top-level properties: extra'));
        assert.ok(msg.includes(`Full line: ${line}`));
    });
});
