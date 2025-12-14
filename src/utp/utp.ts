export class UTPBase {
    type?: string;
    version?: number;
    phase?: Phase;
    time?: number;
    processId?: number;
    severity?: Severity;
    message?: string;
    stacktrace?: string;
    line?: number;
    file?: string;
    name?: string;
    description?: string;
    duration?: number;
    errors?: unknown[];
}

export class UTPMemoryLeak extends UTPBase {
    allocatedMemory?: number;
    memoryLabels?: Record<string, number> | Array<Record<string, number>>;
}

export interface PlayerBuildInfoStep {
    description?: string;
    duration?: number;
    errors?: number;
}

export class UTPPlayerBuildInfo extends UTPBase {
    steps?: PlayerBuildInfoStep[];
}

export type UTP = UTPBase | UTPMemoryLeak | UTPPlayerBuildInfo;

export enum Phase {
    Begin = 'Begin',
    End = 'End',
    Immediate = 'Immediate'
}

export enum Severity {
    Info = 'Info',
    Warning = 'Warning',
    Error = 'Error',
    Exception = 'Exception',
    Assert = 'Assert'
}