import { Logger } from "../logging";

export class UTPBase {
    type?: string;
    version?: number;
    phase?: Phase;
    time?: number;
    processId?: number;
    severity?: Severity;
    message?: string;
    stackTrace?: string;
    line?: number;
    lineNumber?: number;
    file?: string;
    fileName?: string;
    name?: string;
    description?: string;
    duration?: number;
    durationMicroseconds?: number;
    errors?: unknown[];
}

export class UTPAction extends UTPBase { }

export class UTPMemoryLeak extends UTPBase {
    allocatedMemory?: number;
    memoryLabels?: Record<string, number> | Array<Record<string, number>>;
}

export class UTPMemoryLeaks extends UTPMemoryLeak { }

export class UTPLogEntry extends UTPBase { }

export class UTPCompiler extends UTPBase { }

export class UTPTestPlan extends UTPBase {
    tests?: string[];
}

export interface ScreenSettingsInfo {
    ScreenWidth?: number;
    ScreenHeight?: number;
    ScreenRefreshRate?: number;
    Fullscreen?: boolean;
}

export class UTPScreenSettings extends UTPBase {
    ScreenSettings?: ScreenSettingsInfo;
}

export interface PlayerSettingsInfo {
    ScriptingBackend?: string;
    MtRendering?: boolean;
    GraphicsJobs?: boolean;
    GpuSkinning?: boolean;
    GraphicsApi?: string;
    Batchmode?: string;
    StereoRenderingPath?: string;
    RenderThreadingMode?: string;
    AndroidMinimumSdkVersion?: string;
    AndroidTargetSdkVersion?: string;
    ScriptingRuntimeVersion?: string;
    AndroidTargetArchitecture?: string;
    StripEngineCode?: boolean;
}

export class UTPPlayerSettings extends UTPBase {
    PlayerSettings?: PlayerSettingsInfo;
}

export interface BuildSettingsInfo {
    Platform?: string;
    BuildTarget?: string;
    DevelopmentPlayer?: boolean;
    AndroidBuildSystem?: string;
}

export class UTPBuildSettings extends UTPBase {
    BuildSettings?: BuildSettingsInfo;
}

export interface PlayerSystemInfoDetails {
    OperatingSystem?: string;
    DeviceModel?: string;
    DeviceName?: string;
    ProcessorType?: string;
    ProcessorCount?: number;
    GraphicsDeviceName?: string;
    SystemMemorySize?: number;
    XrModel?: string;
    XrDevice?: string;
}

export class UTPPlayerSystemInfo extends UTPBase {
    PlayerSystemInfo?: PlayerSystemInfoDetails;
}

export interface QualitySettingsInfo {
    Vsync?: number;
    AntiAliasing?: number;
    ColorSpace?: string;
    AnisotropicFiltering?: string;
    BlendWeights?: string;
}

export class UTPQualitySettings extends UTPBase {
    QualitySettings?: QualitySettingsInfo;
}

export class UTPTestStatus extends UTPBase {
    state?: number;
    iteration?: number;
}

export interface PlayerBuildInfoStep {
    description?: string;
    duration?: number;
    errors?: number;
}

export class UTPPlayerBuildInfo extends UTPBase {
    steps?: PlayerBuildInfoStep[];
}

export type UTP =
    | UTPAction
    | UTPCompiler
    | UTPBase
    | UTPLogEntry
    | UTPTestPlan
    | UTPScreenSettings
    | UTPPlayerSettings
    | UTPBuildSettings
    | UTPPlayerSystemInfo
    | UTPQualitySettings
    | UTPTestStatus
    | UTPMemoryLeak
    | UTPMemoryLeaks
    | UTPPlayerBuildInfo;

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

const allowedUtpKeys = new Set<string>([
    'allocatedMemory',
    'BuildSettings',
    'description',
    'duration',
    'durationMicroseconds',
    'errors',
    'file',
    'fileName',
    'iteration',
    'line',
    'lineNumber',
    'memoryLabels',
    'message',
    'name',
    'phase',
    'PlayerSettings',
    'PlayerSystemInfo',
    'processId',
    'QualitySettings',
    'ScreenSettings',
    'severity',
    'stacktrace',
    'stackTrace',
    'state',
    'steps',
    'tests',
    'time',
    'type',
    'version',
]);

/**
 * Normalizes UTP telemetry entries to canonical shapes and reports unexpected properties.
 */
export function normalizeTelemetryEntry(entry: unknown): UTP {
    if (!entry || typeof entry !== 'object') {
        return entry as UTP;
    }

    const utp = entry as UTP;
    const record = entry as Record<string, unknown>;

    const stackTraceLegacy = record.stacktrace;

    if (utp.stackTrace === undefined && typeof stackTraceLegacy === 'string') {
        utp.stackTrace = stackTraceLegacy;
    }

    const fileNameLegacy = record.fileName;

    if (utp.file === undefined && typeof fileNameLegacy === 'string') {
        utp.file = fileNameLegacy;
    }

    if (utp.fileName === undefined && typeof utp.file === 'string') {
        utp.fileName = utp.file;
    }

    const lineNumberLegacy = record.lineNumber;

    if (utp.line === undefined && typeof lineNumberLegacy === 'number') {
        utp.line = lineNumberLegacy;
    }

    if (utp.lineNumber === undefined && typeof utp.line === 'number') {
        utp.lineNumber = utp.line;
    }

    if (!utp.type) {
        Logger.instance.warn('UTP entry missing type property; telemetry entry may be ignored.');
    }

    const extras: string[] = [];
    for (const key of Object.keys(record)) {
        if (!allowedUtpKeys.has(key)) {
            extras.push(key);
        }
    }

    if (extras.length > 0) {
        Logger.instance.warn(`UTP entry contains unrecognized properties: ${extras.join(', ')}`);
    }

    return utp;
}