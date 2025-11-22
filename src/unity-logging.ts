import * as fs from 'fs';
import { LogLevel, Logger } from './logging';
import { Delay, WaitForFileToBeUnlocked } from './utilities';
import { Phase, UTP, UTPBase, UTPMemoryLeak } from './utp';

/**
 * Result of the tailLogFile function containing cleanup resources.
 */
export interface LogTailResult {
    /** Promise that resolves when log tailing completes */
    tailPromise: Promise<void>;
    /** Function to signal that log tailing should end */
    stopLogTail: () => void;
    /** Collected telemetry objects parsed from lines beginning with '##utp:' */
    telemetry: any[];
}

/**
 * Editor log messages whose severity has been changed.
 * Useful for making certain error messages that are not critical less noisy.
 * Key is the exact log message, value is the remapped LogLevel.
 */
const remappedEditorLogs: Record<string, LogLevel> = {
    'OpenCL device, baking cannot use GPU lightmapper.': LogLevel.INFO,
    'Failed to find a suitable OpenCL device, baking cannot use GPU lightmapper.': LogLevel.INFO,
};

// Detects GitHub-style annotation markers to avoid emitting duplicates
const annotationPrefixRegex = /\n::[a-z]+::/i;

type MemoryLabelEntry = [string, number];

interface CompletedActionSummary {
    name: string;
    description: string;
    durationMs: number;
    errors: string[];
}

interface PendingActionSummary {
    name: string;
    description: string;
}

export interface ActionTableSnapshot {
    completed: CompletedActionSummary[];
    pending: PendingActionSummary[];
    totalDurationMs: number;
    totalErrorCount: number;
}

interface FormattedTableOutput {
    text: string;
    lineCount: number;
}

const MAX_ERROR_DETAIL_COLUMN_WIDTH = 64;
const TIMELINE_HEADING = '🔨 Unity Build Timeline';
const MIN_DESCRIPTION_COLUMN_WIDTH = 16;
const DEFAULT_TERMINAL_WIDTH = 120;
const TERMINAL_WIDTH_SAFETY_MARGIN = 2;
const MIN_TERMINAL_WIDTH = 40;
const extendedPictographicRegex = /\p{Extended_Pictographic}/u;

class ActionTelemetryAccumulator {
    private pendingActions = new Map<string, UTPBase>();
    private completedActions: CompletedActionSummary[] = [];
    private totalDurationMs = 0;
    private totalErrorCount = 0;

    record(action: UTPBase): boolean {
        if (action.phase === Phase.Begin) {
            this.pendingActions.set(this.getActionKey(action), action);
            return true;
        }

        if (action.phase === Phase.End) {
            const key = this.getActionKey(action);
            let start = this.pendingActions.get(key);
            if (start) {
                this.pendingActions.delete(key);
            } else {
                const fallback = this.findPendingMatchFor(action);
                if (fallback) {
                    start = fallback.action;
                    this.pendingActions.delete(fallback.key);
                }
            }

            const durationMs = this.calculateDurationMs(start, action);
            const errors = this.extractErrors(action);
            const summary: CompletedActionSummary = {
                name: action.name ?? 'Unnamed Action',
                description: action.description ?? '',
                durationMs,
                errors,
            };

            this.completedActions.push(summary);

            this.totalDurationMs += durationMs;
            this.totalErrorCount += errors.length;
            return true;
        }

        return false;
    }

    snapshot(): ActionTableSnapshot | undefined {
        if (this.completedActions.length === 0 && this.pendingActions.size === 0) {
            return undefined;
        }

        return {
            completed: [...this.completedActions],
            pending: Array.from(this.pendingActions.values()).map(action => ({
                name: action.name ?? 'Unnamed Action',
                description: action.description ?? '',
            })),
            totalDurationMs: this.totalDurationMs,
            totalErrorCount: this.totalErrorCount,
        };
    }

    private getActionKey(action: UTPBase): string {
        const pid = action.processId ?? 'na';
        const name = action.name ?? '';
        const description = action.description ?? '';
        return `${pid}::${name}::${description}`;
    }

    private findPendingMatchFor(action: UTPBase): { key: string; action: UTPBase } | undefined {
        for (const [key, pending] of this.pendingActions.entries()) {
            const sameProcess = (pending.processId ?? 'na') === (action.processId ?? 'na');
            const sameName = (pending.name ?? '') === (action.name ?? '');
            if (!sameProcess || !sameName) {
                continue;
            }

            const pendingDescription = pending.description ?? '';
            const endingDescription = action.description ?? '';
            if (!pendingDescription || !endingDescription) {
                continue;
            }

            if (endingDescription.startsWith(pendingDescription) || pendingDescription.startsWith(endingDescription)) {
                return { key, action: pending };
            }
        }

        return undefined;
    }

    private calculateDurationMs(start: UTPBase | undefined, end: UTPBase): number {
        if (start?.time != null && end.time != null) {
            return Math.max(0, end.time - start.time);
        }

        if (typeof end.duration === 'number') {
            return Math.max(0, end.duration);
        }

        return 0;
    }

    private extractErrors(action: UTPBase): string[] {
        if (!Array.isArray(action.errors) || action.errors.length === 0) {
            return [];
        }

        return action.errors.map(formatErrorValue);
    }
}

function formatErrorValue(value: unknown): string {
    if (value instanceof Error) {
        return sanitizeWhitespace(value.message || value.toString());
    }

    if (typeof value === 'string') {
        return sanitizeWhitespace(value);
    }

    try {
        return sanitizeWhitespace(JSON.stringify(value));
    } catch {
        return sanitizeWhitespace(String(value));
    }
}

function sanitizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function formatDuration(ms: number): string {
    if (ms >= 86_400_000) {
        const days = ms / 86_400_000;
        return `${days.toFixed(days >= 10 ? 0 : 1)} d`;
    }

    if (ms >= 3_600_000) {
        const hours = ms / 3_600_000;
        return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`;
    }

    if (ms >= 60_000) {
        const minutes = ms / 60_000;
        return `${minutes.toFixed(minutes >= 10 ? 0 : 1)} m`;
    }

    if (ms >= 1_000) {
        const seconds = ms / 1_000;
        return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
    }

    return `${ms} ms`;
}

function truncate(value: string, maxLength: number): string {
    return truncateDisplay(value, maxLength);
}

function truncateDisplay(value: string, maxWidth: number): string {
    if (maxWidth <= 0) {
        return '';
    }

    if (stringDisplayWidth(value) <= maxWidth) {
        return value;
    }

    if (maxWidth <= 3) {
        let width = 0;
        let result = '';
        for (const symbol of [...value]) {
            const codePoint = symbol.codePointAt(0);
            if (codePoint === undefined) {
                continue;
            }

            const charWidth = charDisplayWidth(codePoint);
            if (width + charWidth > maxWidth) {
                break;
            }
            width += charWidth;
            result += symbol;
            if (width >= maxWidth) {
                break;
            }
        }
        return result;
    }

    const ellipsis = '...';
    const ellipsisWidth = stringDisplayWidth(ellipsis);
    const targetWidth = Math.max(1, maxWidth - ellipsisWidth);
    let width = 0;
    let result = '';
    for (const symbol of [...value]) {
        const codePoint = symbol.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }

        const charWidth = charDisplayWidth(codePoint);
        if (width + charWidth > targetWidth) {
            break;
        }
        width += charWidth;
        result += symbol;
    }

    if (!result) {
        return ellipsis;
    }

    return `${result}${ellipsis}`;
}

export function stringDisplayWidth(value: string): number {
    let width = 0;
    for (const symbol of [...value]) {
        const codePoint = symbol.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }

        width += charDisplayWidth(codePoint);
    }
    return width;
}

function charDisplayWidth(codePoint: number): number {
    if (isZeroWidthCodePoint(codePoint)) {
        return 0;
    }

    if (isEmojiPresentation(codePoint) || isFullWidthCodePoint(codePoint)) {
        return 2;
    }

    return 1;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
    if (codePoint === 0) {
        return true;
    }

    if (codePoint === 0x200d) {
        return true; // zero width joiner used in emoji sequences
    }

    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
        return true;
    }

    if (isCombiningMark(codePoint)) {
        return true;
    }

    if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) {
        return true; // variation selectors
    }

    return false;
}

function isEmojiPresentation(codePoint: number): boolean {
    // Use Unicode Extended_Pictographic to detect emoji that are rendered double-width
    return extendedPictographicRegex.test(String.fromCodePoint(codePoint));
}

function isCombiningMark(codePoint: number): boolean {
    const ranges: Array<[number, number]> = [
        [0x0300, 0x036f],
        [0x0483, 0x0489],
        [0x07eb, 0x07f3],
        [0x135d, 0x135f],
        [0x1ab0, 0x1aff],
        [0x1dc0, 0x1dff],
        [0x20d0, 0x20ff],
        [0xfe20, 0xfe2f],
    ];

    return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function isFullWidthCodePoint(codePoint: number): boolean {
    return codePoint >= 0x1100 && (
        codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
        (codePoint >= 0xff01 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    );
}

function padDisplay(value: string, width: number, alignment: 'left' | 'right' | 'center' = 'left'): string {
    if (width <= 0) {
        return '';
    }

    let text = value;
    let valueWidth = stringDisplayWidth(text);
    if (valueWidth > width) {
        text = truncateDisplay(text, width);
        valueWidth = stringDisplayWidth(text);
    }

    if (valueWidth === width) {
        return text;
    }

    const padding = width - valueWidth;
    if (alignment === 'right') {
        return `${' '.repeat(padding)}${text}`;
    }

    if (alignment === 'center') {
        const left = Math.floor(padding / 2);
        return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
    }

    return `${text}${' '.repeat(padding)}`;
}

function computeTablePadding(columnCount: number): number {
    return columnCount * 3 + 1;
}

function computeTableWidth(columnWidths: Array<number | undefined>): number {
    let sum = 0;
    for (const width of columnWidths) {
        sum += width ?? 0;
    }
    return sum + computeTablePadding(columnWidths.length);
}

function adjustDescriptionColumnWidth(columnWidths: Array<number | undefined>, descriptionColumnIndex: number, descriptionHeaderWidth: number, maxWidth?: number): Array<number | undefined> {
    if (maxWidth === undefined || !Number.isFinite(maxWidth) || maxWidth <= 0) {
        return columnWidths;
    }

    const targetWidth = Math.floor(maxWidth);
    const totalWidth = computeTableWidth(columnWidths);
    const paddingWidth = computeTablePadding(columnWidths.length);

    let sumWithoutDescription = 0;
    columnWidths.forEach((width, index) => {
        if (index === descriptionColumnIndex) {
            return;
        }
        sumWithoutDescription += width ?? 0;
    });
    const minDescriptionWidth = Math.max(descriptionHeaderWidth, MIN_DESCRIPTION_COLUMN_WIDTH);
    const currentDescriptionWidth = columnWidths[descriptionColumnIndex] ?? minDescriptionWidth;
    const availableWidthForDescription = targetWidth - paddingWidth - sumWithoutDescription;

    if (totalWidth <= targetWidth) {
        columnWidths[descriptionColumnIndex] = Math.max(currentDescriptionWidth, availableWidthForDescription);
        return columnWidths;
    }

    if (availableWidthForDescription >= minDescriptionWidth) {
        columnWidths[descriptionColumnIndex] = Math.max(minDescriptionWidth, Math.min(currentDescriptionWidth, availableWidthForDescription));
        return columnWidths;
    }

    columnWidths[descriptionColumnIndex] = minDescriptionWidth;
    return columnWidths;
}

function buildBorderLine(columnWidths: number[], left: string, middle: string, right: string): string {
    let result = left;
    columnWidths.forEach((width, index) => {
        const segmentWidth = Math.max(0, width + 2);
        result += '─'.repeat(segmentWidth);
        result += index === columnWidths.length - 1 ? right : middle;
    });
    return result;
}

export function formatActionTimelineTable(snapshot: ActionTableSnapshot, options?: { maxWidth?: number }): FormattedTableOutput | undefined {
    const showErrorsColumn = snapshot.totalErrorCount > 0;

    interface TableRow {
        status: string;
        description: string;
        durationText: string;
        errorsText?: string;
    }

    const tableRows: TableRow[] = [];

    snapshot.pending.forEach(action => {
        const row: TableRow = {
            status: '⏳',
            description: action.description ?? '',
            durationText: '...',
        };
        if (showErrorsColumn) {
            row.errorsText = '';
        }
        tableRows.push(row);
    });

    snapshot.completed.forEach(action => {
        const row: TableRow = {
            status: action.errors.length > 0 ? '❌' : '✅',
            description: action.description ?? '',
            durationText: formatDuration(action.durationMs),
        };
        if (showErrorsColumn) {
            row.errorsText = action.errors.length.toString();
        }
        tableRows.push(row);
    });

    if (tableRows.length === 0) {
        return undefined;
    }

    const totalsRow: TableRow = {
        status: 'Σ',
        description: ' Total Build Duration',
        durationText: formatDuration(snapshot.totalDurationMs),
    };
    if (showErrorsColumn) {
        totalsRow.errorsText = snapshot.totalErrorCount.toString();
    }

    const statusHeader = 'Status';
    const descriptionHeader = 'Description';
    const durationHeader = 'Duration';
    const errorsHeader = '# of Errors';

    let statusWidth = Math.max(stringDisplayWidth(statusHeader), ...tableRows.map(row => stringDisplayWidth(row.status)), stringDisplayWidth(totalsRow.status));
    let descriptionWidth = Math.max(stringDisplayWidth(descriptionHeader), ...tableRows.map(row => stringDisplayWidth(row.description)), stringDisplayWidth(totalsRow.description));
    let durationWidth = Math.max(stringDisplayWidth(durationHeader), ...tableRows.map(row => stringDisplayWidth(row.durationText)), stringDisplayWidth(totalsRow.durationText));
    let errorsWidth = showErrorsColumn ? Math.max(stringDisplayWidth(errorsHeader), ...tableRows.map(row => stringDisplayWidth(row.errorsText ?? '')), stringDisplayWidth(totalsRow.errorsText ?? '')) : 0;

    let columns: Array<number | undefined> = showErrorsColumn
        ? [statusWidth, descriptionWidth, durationWidth, errorsWidth]
        : [statusWidth, descriptionWidth, durationWidth];

    columns = adjustDescriptionColumnWidth(columns, 1, stringDisplayWidth(descriptionHeader), options?.maxWidth);
    statusWidth = columns[0] ?? statusWidth;
    descriptionWidth = columns[1] ?? descriptionWidth;
    durationWidth = columns[2] ?? durationWidth;
    if (showErrorsColumn) {
        errorsWidth = columns[3] ?? errorsWidth;
    }

    const resolvedColumns = showErrorsColumn
        ? [statusWidth, descriptionWidth, durationWidth, errorsWidth]
        : [statusWidth, descriptionWidth, durationWidth];

    const padStatus = (value: string): string => padDisplay(value, statusWidth, 'center');

    const formatRow = (row: TableRow): string => {
        let line = `│ ${padStatus(row.status)} │ ${padDisplay(row.description, descriptionWidth)} │ ${padDisplay(row.durationText, durationWidth, 'right')} │`;
        if (showErrorsColumn) {
            line += ` ${padDisplay(row.errorsText ?? '', errorsWidth, 'right')} │`;
        }
        return line;
    };

    const topBorder = buildBorderLine(resolvedColumns, '┌', '┬', '┐');
    const headerRow = showErrorsColumn
        ? `│ ${padStatus(statusHeader)} │ ${padDisplay(descriptionHeader, descriptionWidth)} │ ${padDisplay(durationHeader, durationWidth, 'right')} │ ${padDisplay(errorsHeader, errorsWidth, 'right')} │`
        : `│ ${padStatus(statusHeader)} │ ${padDisplay(descriptionHeader, descriptionWidth)} │ ${padDisplay(durationHeader, durationWidth, 'right')} │`;
    const headerDivider = buildBorderLine(resolvedColumns, '├', '┼', '┤');
    const totalsDivider = buildBorderLine(resolvedColumns, '├', '┼', '┤');
    const bottomBorder = buildBorderLine(resolvedColumns, '└', '┴', '┘');

    let output = `${TIMELINE_HEADING}\n`;
    output += `${topBorder}\n`;
    output += `${headerRow}\n`;
    output += `${headerDivider}\n`;

    tableRows.forEach(row => {
        output += `${formatRow(row)}\n`;
    });

    output += `${totalsDivider}\n`;
    output += `${formatRow(totalsRow)}\n`;
    output += `${bottomBorder}\n`;

    if (showErrorsColumn && snapshot.totalErrorCount > 0) {
        const errorRows: Array<{ description: string; detail: string }> = [];
        snapshot.completed.forEach(action => {
            if (action.errors.length === 0) { return; }
            const description = truncate(action.description || '', MAX_ERROR_DETAIL_COLUMN_WIDTH);
            action.errors.forEach(err => {
                errorRows.push({
                    description,
                    detail: truncate(err, MAX_ERROR_DETAIL_COLUMN_WIDTH),
                });
            });
        });

        if (errorRows.length > 0) {
            const errorDescriptionWidth = Math.max(stringDisplayWidth(descriptionHeader), ...errorRows.map(errRow => stringDisplayWidth(errRow.description)));
            const detailHeader = 'Error';
            const detailWidth = Math.max(stringDisplayWidth(detailHeader), ...errorRows.map(errRow => stringDisplayWidth(errRow.detail)));

            const errorColumns = [errorDescriptionWidth, detailWidth];
            const errorHeaderRow = `│ ${padDisplay(descriptionHeader, errorDescriptionWidth)} │ ${padDisplay(detailHeader, detailWidth)} │`;
            const errorTop = buildBorderLine(errorColumns, '┌', '┬', '┐');
            const errorDivider = buildBorderLine(errorColumns, '├', '┼', '┤');
            const errorBottom = buildBorderLine(errorColumns, '└', '┴', '┘');

            output += '\nError Details\n';
            output += `${errorTop}\n`;
            output += `${errorHeaderRow}\n`;
            output += `${errorDivider}\n`;
            errorRows.forEach(detailRow => {
                output += `│ ${padDisplay(detailRow.description, errorDescriptionWidth)} │ ${padDisplay(detailRow.detail, detailWidth)} │\n`;
            });
            output += `${errorBottom}\n`;
        }
    }

    output += '\n';

    return {
        text: output,
        lineCount: countLines(output),
    };
}

function countLines(block: string): number {
    if (!block) {
        return 0;
    }

    const normalized = block.endsWith('\n') ? block : `${block}\n`;
    return normalized.split('\n').length - 1;
}

export class ActionTableRenderer {
    private lastRenderLineCount = 0;
    private anchorActive = false;

    constructor(private readonly canUpdateTerminal: boolean) { }

    prepareForContent(): void {
        if (!this.canUpdateTerminal) {
            return;
        }
        this.clearTimelineRegion();
    }

    render(snapshot: ActionTableSnapshot | undefined): void {
        if (!snapshot) {
            this.clearTimelineRegion();
            return;
        }

        const formatted = formatActionTimelineTable(snapshot, { maxWidth: this.getMaxWidth() });

        if (!formatted) {
            this.clearTimelineRegion();
            return;
        }

        if (this.canUpdateTerminal) {
            this.clearTimelineRegion();
            process.stdout.write(formatted.text);
            this.anchorActive = true;
            this.lastRenderLineCount = formatted.lineCount;
        } else {
            process.stdout.write(formatted.text);
        }
    }

    private clearTimelineRegion(): void {
        if (!this.anchorActive || this.lastRenderLineCount <= 0) {
            return;
        }

        this.rewindToAnchor();
        process.stdout.write('\u001b[J');
        this.anchorActive = false;
        this.lastRenderLineCount = 0;
    }

    private rewindToAnchor(): void {
        // The TIMELINE_HEADING line is our anchor; rewind to it before clearing so updates stay in place.
        const linesToMove = this.lastRenderLineCount;
        if (linesToMove <= 0) {
            return;
        }
        process.stdout.write(`\u001b[${linesToMove}F`);
    }

    private getMaxWidth(): number {
        const detectedWidth = this.detectTerminalWidth();
        const adjustedWidth = detectedWidth - TERMINAL_WIDTH_SAFETY_MARGIN;
        return Math.max(MIN_TERMINAL_WIDTH, adjustedWidth);
    }

    private detectTerminalWidth(): number {
        const stdoutColumns = typeof process.stdout.columns === 'number' ? process.stdout.columns : undefined;
        if (stdoutColumns && stdoutColumns > 0) {
            return stdoutColumns;
        }

        const envColumns = Number(process.env.COLUMNS);
        if (Number.isFinite(envColumns) && envColumns > 0) {
            return envColumns;
        }

        return DEFAULT_TERMINAL_WIDTH;
    }

}

function toNumeric(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeMemoryLabelEntries(memoryLabels: UTPMemoryLeak['memoryLabels']): MemoryLabelEntry[] {
    if (!memoryLabels) { return []; }

    if (Array.isArray(memoryLabels)) {
        const entries: MemoryLabelEntry[] = [];
        for (const labelObject of memoryLabels) {
            for (const [label, value] of Object.entries(labelObject)) {
                const numericValue = toNumeric(value);
                if (numericValue !== undefined) {
                    entries.push([label, numericValue]);
                }
            }
        }
        return entries;
    }

    return Object.entries(memoryLabels)
        .map<MemoryLabelEntry | undefined>(([label, value]) => {
            const numericValue = toNumeric(value);
            return numericValue === undefined ? undefined : [label, numericValue];
        })
        .filter((entry): entry is MemoryLabelEntry => entry !== undefined);
}

function formatMemoryLeakTable(memLeaks: UTPMemoryLeak): string {
    const rows = normalizeMemoryLabelEntries(memLeaks.memoryLabels);
    const allocated = memLeaks.allocatedMemory ?? 0;
    const labelHeader = 'Label';
    const sizeHeader = 'Size';
    const totalLabel = 'Total';
    const nonePlaceholder = '(none)';
    const totalValueStr = allocated.toString();

    const rowLabelWidth = rows.length > 0 ? Math.max(...rows.map(([label]) => label.length)) : nonePlaceholder.length;
    const rowSizeWidth = rows.length > 0 ? Math.max(...rows.map(([, size]) => size.toString().length)) : 0;

    const labelWidth = Math.max(labelHeader.length, totalLabel.length, rowLabelWidth);
    const sizeWidth = Math.max(sizeHeader.length, totalValueStr.length, rowSizeWidth);

    const columns = [labelWidth, sizeWidth];
    const topBorder = buildBorderLine(columns, '┌', '┬', '┐');
    const headerDivider = buildBorderLine(columns, '├', '┼', '┤');
    const bottomBorder = buildBorderLine(columns, '└', '┴', '┘');

    let output = 'Memory Leaks Detected:\n';
    output += `${topBorder}\n`;
    output += `│ ${labelHeader.padEnd(labelWidth)} │ ${sizeHeader.padStart(sizeWidth)} │\n`;
    output += `${headerDivider}\n`;

    if (rows.length === 0) {
        output += `│ ${nonePlaceholder.padEnd(labelWidth)} │ ${''.padStart(sizeWidth)} │\n`;
    } else {
        for (const [label, size] of rows) {
            output += `│ ${label.padEnd(labelWidth)} │ ${size.toString().padStart(sizeWidth)} │\n`;
        }
    }

    output += `${headerDivider}\n`;
    output += `│ ${totalLabel.padEnd(labelWidth)} │ ${totalValueStr.padStart(sizeWidth)} │\n`;
    output += `${bottomBorder}\n`;

    return output;
}

/**
 * Tails a log file using fs.watch and ReadStream for efficient reading.
 * @param logPath The path to the log file to tail.
 * @param projectPath The path to the project (used for log annotation).
 * @returns An object containing the tail promise and signalEnd function.
 */
export function TailLogFile(logPath: string, projectPath: string | undefined): LogTailResult {
    let logEnded = false;
    let lastSize = 0;
    const logPollingInterval = 250;
    const telemetry: UTP[] = [];
    const logger = Logger.instance;
    const actionAccumulator = new ActionTelemetryAccumulator();
    const actionTableRenderer = new ActionTableRenderer(process.stdout.isTTY === true && process.env.CI !== 'true');

    const renderActionTable = (): void => {
        const snapshot = actionAccumulator.snapshot();
        if (snapshot) {
            actionTableRenderer.render(snapshot);
        }
    };

    const writeStdout = (content: string, restoreTable: boolean = true): void => {
        actionTableRenderer.prepareForContent();
        process.stdout.write(content);
        if (restoreTable) {
            renderActionTable();
        }
    };

    async function readNewLogContent(): Promise<void> {
        try {
            if (!fs.existsSync(logPath)) { return; }
            const stats = await fs.promises.stat(logPath);
            if (stats.size < lastSize) { lastSize = 0; }

            if (stats.size > lastSize) {
                const bytesToRead = stats.size - lastSize;
                const buffer = Buffer.alloc(bytesToRead);
                let fh: fs.promises.FileHandle | undefined;

                try {
                    fh = await fs.promises.open(logPath, fs.constants.O_RDONLY);
                    await fh.read(buffer, 0, bytesToRead, lastSize);
                } finally {
                    await fh?.close();
                }

                lastSize = stats.size;

                if (bytesToRead > 0) {
                    const chunk = buffer.toString('utf8');

                    // Parse telemetry lines in this chunk (lines starting with '##utp:')
                    try {
                        const lines = chunk.split(/\r?\n/);
                        for (const rawLine of lines) {
                            const line = rawLine.trim();
                            if (!line) { continue; }

                            // Attempt to parse telemetry utp JSON
                            if (line.startsWith('##utp:')) {
                                const jsonPart = line.substring('##utp:'.length).trim();
                                try {
                                    const utpJson = JSON.parse(jsonPart);
                                    const utp = utpJson as UTP;
                                    telemetry.push(utp);

                                    if (utp.message && 'severity' in utp && (utp.severity === 'Error' || utp.severity === 'Exception' || utp.severity === 'Assert')) {
                                        let messageLevel: LogLevel = LogLevel.ERROR;

                                        if (remappedEditorLogs[utp.message] !== undefined) {
                                            messageLevel = remappedEditorLogs[utp.message] as LogLevel;
                                        }

                                        const file = utp.file ? utp.file.replace(/\\/g, '/') : undefined;
                                        const lineNum = utp.line ? utp.line : undefined;
                                        const message = utp.message;
                                        const stacktrace = utp.stacktrace ? `${utp.stacktrace}` : undefined;

                                        if (!annotationPrefixRegex.test(message)) {
                                            // only annotate if the file is within the current project
                                            if (projectPath && file && file.startsWith(projectPath)) {
                                                logger.annotate(LogLevel.ERROR, stacktrace == undefined ? message : `${message}\n${stacktrace}`, file, lineNum);
                                            } else {
                                                switch (messageLevel) {
                                                    case LogLevel.WARN:
                                                        logger.warn(stacktrace == undefined ? message : `${message}\n${stacktrace}`);
                                                        break;
                                                    case LogLevel.ERROR:
                                                        logger.error(stacktrace == undefined ? message : `${message}\n${stacktrace}`);
                                                        break;
                                                    case LogLevel.INFO:
                                                    default:
                                                        logger.info(stacktrace == undefined ? message : `${message}\n${stacktrace}`);
                                                        break;
                                                }
                                            }
                                        }
                                    } else {
                                        // switch utp types, fallback to json if we don't have a toString() implementation or a type implementation
                                        switch (utp.type) {
                                            case 'Action': {
                                                const actionEntry = utp as UTPBase;
                                                const tableChanged = actionAccumulator.record(actionEntry);
                                                if (tableChanged) {
                                                    renderActionTable();
                                                }
                                                break;
                                            }
                                            case 'MemoryLeaks':
                                                logger.debug(formatMemoryLeakTable(utp as UTPMemoryLeak));
                                                break;
                                            default:
                                                // Print raw JSON for unhandled UTP types
                                                writeStdout(`${jsonPart}\n`);
                                                break;
                                        }
                                    }
                                } catch (error) {
                                    logger.warn(`Failed to parse telemetry JSON: ${error} -- raw: ${jsonPart}`);
                                }
                            } else {
                                if (Logger.instance.logLevel !== LogLevel.UTP) {
                                    writeStdout(`${line}\n`);
                                }
                            }
                        }
                    } catch (error: any) {
                        if (error.code !== 'EPIPE') {
                            throw error;
                        }
                        logger.warn(`Error while parsing telemetry from log chunk: ${error} `);
                    }
                }
            }
        } catch (error) {
            logger.warn(`Error while tailing log file: ${error} `);
        }
    }

    const tailPromise = new Promise<void>((resolve, reject) => {
        (async () => {
            try {
                while (!logEnded) {
                    await Delay(logPollingInterval);
                    await readNewLogContent();
                }

                // Final read to capture any remaining content after tailing stops
                await WaitForFileToBeUnlocked(logPath, 10_000);
                await readNewLogContent();

                try {
                    // write a final newline to separate log output
                    writeStdout('\n');
                } catch (error: any) {
                    if (error.code !== 'EPIPE') {
                        logger.warn(`Error while writing log tail: ${error} `);
                    }
                }

                resolve();
            } catch (error) {
                reject(error);
            }
        })();
    });

    function stopLogTail(): void {
        logEnded = true;
    }

    return { tailPromise, stopLogTail, telemetry };
}
