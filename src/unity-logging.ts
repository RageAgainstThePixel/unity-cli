import * as fs from 'fs';
import { LogLevel, Logger } from './logging';
import { Delay, WaitForFileToBeUnlocked } from './utilities';
import { UTP, UTPBase, UTPMemoryLeak } from './utp';

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

    let output = 'Memory Leaks Detected:\n';
    output += `${'-'.repeat(labelWidth + sizeWidth + 7)}\n`;
    output += `| ${labelHeader.padEnd(labelWidth)} | ${sizeHeader.padStart(sizeWidth)} |\n`;
    output += `|${'-'.repeat(labelWidth + 2)}|${'-'.repeat(sizeWidth + 2)}|\n`;

    if (rows.length === 0) {
        output += `| ${nonePlaceholder.padEnd(labelWidth)} | ${''.padStart(sizeWidth)} |\n`;
    } else {
        for (const [label, size] of rows) {
            output += `| ${label.padEnd(labelWidth)} | ${size.toString().padStart(sizeWidth)} |\n`;
        }
    }

    output += `| ${totalLabel.padEnd(labelWidth)} | ${totalValueStr.padStart(sizeWidth)} |\n`;
    output += `${'-'.repeat(labelWidth + sizeWidth + 7)}\n`;

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
                                            case 'Action':
                                                const logEntry = utp as UTPBase;
                                                process.stdout.write(`${JSON.stringify(logEntry, null, 2)}\n`);
                                                break;
                                            case 'MemoryLeaks':
                                                logger.debug(formatMemoryLeakTable(utp as UTPMemoryLeak));
                                                break;
                                            default:
                                                // Print raw JSON for unhandled UTP types
                                                process.stdout.write(`${jsonPart}\n`);
                                                break;
                                        }
                                    }
                                } catch (error) {
                                    logger.warn(`Failed to parse telemetry JSON: ${error} -- raw: ${jsonPart}`);
                                }
                            } else {
                                if (Logger.instance.logLevel !== LogLevel.UTP) {
                                    process.stdout.write(`${line}\n`);
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
                    process.stdout.write('\n');
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
