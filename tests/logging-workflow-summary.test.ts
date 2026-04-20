import { Logger } from '../src/logging';
import type { UTP } from '../src/utp';

describe('workflow summary formatting', () => {
    it('renders build timeline and log entries in plaintext code blocks', () => {
        const summaryWrites: string[] = [];
        const logger = Logger.instance as unknown as {
            _provider: {
                appendStepSummary: (summary: string) => void;
                getMarkdownByteLimit: (target: 'workflow-summary' | 'stdout') => number;
            };
        };

        logger._provider = {
            appendStepSummary: (summary: string) => summaryWrites.push(summary),
            getMarkdownByteLimit: () => 1024 * 1024,
        };

        const telemetry: UTP[] = [
            {
                type: 'Action',
                phase: 'End',
                description: 'Build Player',
                duration: 1234,
                errors: [],
            } as UTP,
            {
                type: 'Compiler',
                severity: 'Error',
                file: 'Assets/UnityCliTests/CompilerErrors.cs',
                line: 2,
                message: "error CS1029: #error: 'Intentional compiler error: CS1029'",
            } as UTP,
        ];

        Logger.instance.CI_appendWorkflowSummary('Build-Unity', telemetry);

        expect(summaryWrites).toHaveLength(1);
        const summary = summaryWrites[0];
        expect(summary).toContain('```text');
        expect(summary).toContain('✅ 1.2s 0 — Build Player');
        expect(summary).toContain(`Assets/UnityCliTests/CompilerErrors.cs(2): error CS1029: #error: 'Intentional compiler error: CS1029'`);
        expect(summary).not.toContain('- ✅');
    });

    it('collapses multiline log messages into one summary line', () => {
        const summaryWrites: string[] = [];
        const logger = Logger.instance as unknown as {
            _provider: {
                appendStepSummary: (summary: string) => void;
                getMarkdownByteLimit: (target: 'workflow-summary' | 'stdout') => number;
            };
        };

        logger._provider = {
            appendStepSummary: (summary: string) => summaryWrites.push(summary),
            getMarkdownByteLimit: () => 1024 * 1024,
        };

        const telemetry: UTP[] = [
            {
                type: 'Compiler',
                severity: 'Error',
                file: 'Assets/UnityCliTests/CompilerErrors.cs',
                line: 2,
                message: 'Scripts have compiler errors.\nAccess token is unavailable; failed to update',
            } as UTP,
        ];

        Logger.instance.CI_appendWorkflowSummary('Build-Unity', telemetry);

        expect(summaryWrites).toHaveLength(1);
        const summary = summaryWrites[0];
        expect(summary).toContain('Scripts have compiler errors. Access token is unavailable; failed to update');
        expect(summary).not.toContain('\n- Access token is unavailable; failed to update');
    });
});
