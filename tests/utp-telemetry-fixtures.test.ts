import * as fs from 'fs';
import * as path from 'path';
import {
    normalizeTelemetryEntry,
    Severity,
    UTP_SUPPORTED_TOP_LEVEL_PROPERTIES,
} from '../src/utp';
import { buildTestResultsTableMarkdown, utpToTestResultSummary } from '../src/logging';
import { formatUtpUnrecognizedTopLevelPropertiesMessage } from '../src/unity-logging';

const fixturesDir = path.join(__dirname, 'fixtures', 'utp');

function loadFixture(name: string): unknown[] {
    const p = path.join(fixturesDir, name);
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as unknown;
    return Array.isArray(data) ? data : [data];
}

describe('UTP telemetry fixtures', () => {
    const fixtureFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));

    it.each(fixtureFiles)('%s has only supported top-level keys and normalizes cleanly', fileName => {
        for (const obj of loadFixture(fileName)) {
            const { utp, unknownTopLevelKeys } = normalizeTelemetryEntry(obj);
            expect(unknownTopLevelKeys).toEqual([]);
            expect(utp).toBeDefined();
            for (const k of Object.keys(obj as object)) {
                expect(UTP_SUPPORTED_TOP_LEVEL_PROPERTIES.has(k)).toBe(true);
            }
        }
    });

    it('merges legacy stacktrace and file/line fields on Compiler', () => {
        const [first] = loadFixture('compiler-and-logentry.json');
        const { utp } = normalizeTelemetryEntry(first);
        expect(utp.type).toBe('Compiler');
        expect(utp.stackTrace).toBe('');
        expect(utp.file).toBe('Assets/UnityCliTests/CompilerErrors.cs');
        expect(utp.fileName).toBe('Assets/UnityCliTests/CompilerErrors.cs');
        expect(utp.line).toBe(2);
        expect(utp.lineNumber).toBe(2);
    });

    it('maps TestStatus fixtures to summaries and markdown', () => {
        const rows = loadFixture('test-status.json').map(e => {
            const { utp } = normalizeTelemetryEntry(e);
            return utpToTestResultSummary(utp);
        });
        expect(rows[0].status).toBe('✅');
        expect(rows[1].status).toBe('❌');
        expect(rows[2].status).toBe('⏭️');
        expect(rows[3].status).toBe('◯');
        expect(rows[1].durationMs).toBe(5000);
        const md = buildTestResultsTableMarkdown(rows, 1024 * 1024, '');
        expect(md).toContain('### Test results');
        expect(md).toContain('EditMode.Foo.Passes');
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
        expect(unknownTopLevelKeys).toEqual(['futureUnityOnlyField']);
        expect(utp.type).toBe('Compiler');
    });
});

describe('normalizeTelemetryEntry benign severity remaps', () => {
    it('remaps player-connection multicast Error to Info', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'Error',
            message: 'Unable to join player connection multicast group (err: 10013).',
        });
        expect(utp.severity).toBe(Severity.Info);
    });

    it('remaps Socket bind failed / WSAEACCES permission Errors to Info', () => {
        const bind = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'Error',
            message:
                'Socket: bind failed, error: An attempt was made to access a socket in a way forbidden by its access permissions.',
        }).utp;
        expect(bind.severity).toBe(Severity.Info);

        const plainExtracted = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Error,
            message: 'An attempt was made to access a socket in a way forbidden by its access permissions.',
        }).utp;
        expect(plainExtracted.severity).toBe(Severity.Info);
    });

    it('remaps OpenCL and StackAllocator elevated severities to Info', () => {
        const opencl = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Error,
            message: 'Failed to find a suitable OpenCL device, baking cannot use GPU lightmapper.',
        }).utp;
        expect(opencl.severity).toBe(Severity.Info);

        const stack = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: Severity.Assert,
            message: '~StackAllocator(ALLOC_TEMP_MAIN) m_LastAlloc not NULL. Did you forget to call FreeAllStackAllocations()?',
        }).utp;
        expect(stack.severity).toBe(Severity.Info);
    });

    it('leaves real Errors unchanged', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'Compiler',
            severity: 'Error',
            message: 'Assets/Foo.cs(1,1): error CS0001: boom',
        });
        expect(utp.severity).toBe(Severity.Error);
    });

    it('canonicalizes severity casing', () => {
        const { utp } = normalizeTelemetryEntry({
            type: 'LogEntry',
            severity: 'error',
            message: 'real failure',
        });
        expect(utp.severity).toBe(Severity.Error);
    });
});

describe('formatUtpUnrecognizedTopLevelPropertiesMessage', () => {
    it('includes unknown key names and the full ##utp line', () => {
        const line = '##utp:{"type":"Action","extra":1}';
        const msg = formatUtpUnrecognizedTopLevelPropertiesMessage(['extra'], line);
        expect(msg).toContain('unrecognized top-level properties: extra');
        expect(msg).toContain(`Full line: ${line}`);
    });
});
