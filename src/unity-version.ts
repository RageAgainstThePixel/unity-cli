import * as os from 'os';
import { Logger } from './logging';
import {
    Range,
    RangeOptions,
    SemVer,
    coerce,
    compare,
    satisfies
} from 'semver';

type UnityReleaseInfo = {
    version: string;
    major: number;
    minor: number;
    patch: number;
    channel: 'a' | 'b' | 'c' | 'f' | 'p' | 'x';
    revision: number;
};

export class UnityVersion {
    public readonly version: string;
    public readonly changeset: string | null | undefined;
    public readonly architecture: 'X86_64' | 'ARM64';

    private readonly semVer: SemVer;
    private readonly logger = Logger.instance;

    constructor(
        version: string,
        changeset: string | null | undefined = undefined,
        architecture: 'X86_64' | 'ARM64' | undefined = undefined
    ) {
        this.version = version;
        this.changeset = changeset;
        this.semVer = UnityVersion.createSemVer(version);

        // Default to current architecture if not specified
        const resolvedArchitecture = architecture ?? (os.arch() === 'arm64' ? 'ARM64' : 'X86_64');

        this.architecture = resolvedArchitecture === 'ARM64' && !this.isArmCompatible()
            ? 'X86_64'
            : resolvedArchitecture;
    }

    static compare(a: UnityVersion, b: UnityVersion): number {
        const baseComparison = UnityVersion.baseCompare(a, b);

        if (baseComparison !== 0) {
            return baseComparison;
        }

        return UnityVersion.compareBuildMetadata(a.semVer, b.semVer);
    }

    static baseCompare(a: UnityVersion, b: UnityVersion): number {
        return compare(a.semVer, b.semVer, true);
    }

    toString(): string {
        return this.changeset ? `${this.version} (${this.changeset})` : this.version;
    }

    isLegacy(): boolean {
        return this.semVer.major <= 4;
    }

    isArmCompatible(): boolean {
        if (this.semVer.major < 2021) { return false; }
        return compare(this.semVer, '2021.0.0', true) >= 0;
    }

    isFullyQualified(): boolean {
        return UnityVersion.UNITY_RELEASE_PATTERN.test(this.version);
    }

    findMatch(versions: string[] | UnityVersion[], channels: string[] = ['f']): UnityVersion {
        const releaseInfos = UnityVersion.extractReleaseVersions(versions);
        const releaseMap = new Map(releaseInfos.map(info => [info.version, info]));
        const exactMatch = releaseMap.get(this.version);

        if (exactMatch) {
            this.logger.debug(`Exact match found for ${this.version}`);
            return new UnityVersion(exactMatch.version, this.changeset ?? null, this.architecture);
        }

        this.logger.debug(`ReleaseInfos:`);
        releaseInfos.forEach(release => {
            this.logger.debug(`  > ${release.version}`);
        });

        if (UnityVersion.needsGlobSearch(this.version)) {
            this.logger.debug(`Performing glob search for ${this.version} in channels: ${channels.join(', ')} ...`);
            const candidates = UnityVersion.resolveVersionCandidates(this.version, releaseInfos, channels);
            this.logger.debug(`Searching for match for ${this.version} from candidates:`);
            candidates.forEach(candidate => {
                this.logger.debug(`  > ${candidate.version}`);
            });

            const latest = candidates[0];

            if (latest) {
                this.logger.debug(`Found Unity ${latest.version}`);
                return new UnityVersion(latest.version, null, this.architecture);
            }
        }

        this.logger.debug(`No matching Unity version found for ${this.version}`);
        return this;
    }

    satisfies(version: UnityVersion): boolean {
        return satisfies(version.semVer, `^${this.semVer.version}`);
    }

    isGreaterThan(other: string | UnityVersion): boolean {
        const otherVersion = other instanceof UnityVersion ? other : new UnityVersion(other);
        return UnityVersion.baseCompare(this, otherVersion) > 0;
    }

    isGreaterThanOrEqualTo(other: string | UnityVersion): boolean {
        const otherVersion = other instanceof UnityVersion ? other : new UnityVersion(other);
        return UnityVersion.baseCompare(this, otherVersion) >= 0;
    }

    isLessThan(other: string | UnityVersion): boolean {
        const otherVersion = other instanceof UnityVersion ? other : new UnityVersion(other);
        return UnityVersion.baseCompare(this, otherVersion) < 0;
    }

    isLessThanOrEqualTo(other: string | UnityVersion): boolean {
        const otherVersion = other instanceof UnityVersion ? other : new UnityVersion(other);
        return UnityVersion.baseCompare(this, otherVersion) <= 0;
    }

    range(string: string | Range, options: RangeOptions | undefined = undefined): boolean {
        return satisfies(this.semVer, string, options);
    }

    equals(other: UnityVersion): boolean {
        return UnityVersion.compare(this, other) === 0;
    }

    private static readonly UNITY_RELEASE_PATTERN = /^(\d{1,4})\.(\d+)\.(\d+)([abcfpx])(\d+)$/;
    private static readonly VERSION_TOKEN_PATTERN = /^(\d{1,4})(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/;

    private static readonly UNITY_CHANNEL_ORDER: Record<string, number> = {
        a: 0,
        b: 1,
        p: 2,
        c: 3,
        f: 4,
        x: 5
    };

    private static createSemVer(version: string): SemVer {
        const unityMatch = UnityVersion.UNITY_RELEASE_PATTERN.exec(version);

        if (unityMatch) {
            const [, major, minor, patch, channel, build] = unityMatch;
            return new SemVer(`${major}.${minor}.${patch}+${channel}${build}`, true);
        }

        const coercedVersion = coerce(version, { loose: true });

        if (!coercedVersion) {
            throw new Error(`Invalid Unity version: ${JSON.stringify(version)}`);
        }

        return coercedVersion;
    }

    private static extractReleaseVersions(versions: string[] | UnityVersion[]): UnityReleaseInfo[] {
        return versions
            .map(UnityVersion.parseReleaseInfo)
            .filter((info): info is UnityReleaseInfo => info !== null);
    }

    private static compareBuildMetadata(aSemVer: SemVer, bSemVer: SemVer): number {
        const aBuild = UnityVersion.parseBuildMetadata(aSemVer.build);
        const bBuild = UnityVersion.parseBuildMetadata(bSemVer.build);
        if (!aBuild && !bBuild) { return 0; }
        if (!aBuild) { return -1; }
        if (!bBuild) { return 1; }
        if (aBuild.channelRank !== bBuild.channelRank) { return aBuild.channelRank - bBuild.channelRank; }
        if (aBuild.revision !== bBuild.revision) { return aBuild.revision - bBuild.revision; }
        return aBuild.raw.localeCompare(bBuild.raw);
    }

    private static parseBuildMetadata(buildTokens: readonly string[]): {
        raw: string;
        channelRank: number;
        revision: number;
    } | null {
        if (!buildTokens.length) { return null; }
        const raw = buildTokens.join('.');
        const match = raw.match(/^([abcfpx])(\d+)$/);

        if (!match) {
            return {
                raw,
                channelRank: Number.MAX_SAFE_INTEGER,
                revision: Number.MAX_SAFE_INTEGER
            };
        }

        const channel = match[1] as keyof typeof UnityVersion.UNITY_CHANNEL_ORDER;
        const revision = parseInt(match[2]!, 10);

        return {
            raw,
            channelRank: UnityVersion.UNITY_CHANNEL_ORDER[channel] ?? Number.MAX_SAFE_INTEGER,
            revision
        };
    }

    private static parseReleaseInfo(release: string | UnityVersion): UnityReleaseInfo | null {
        if (release instanceof UnityVersion) {
            release = release.version;
        }

        const versionMatch = release.match(/(\d{1,4}\.\d+\.\d+[abcfpx]\d+)/);

        if (!versionMatch) {
            return null;
        }

        const version = versionMatch[1]!;
        const parts = UnityVersion.UNITY_RELEASE_PATTERN.exec(version);

        if (!parts) {
            return null;
        }

        const majorStr = parts[1]!;
        const minorStr = parts[2]!;
        const patchStr = parts[3]!;
        const channel = parts[4]! as UnityReleaseInfo['channel'];
        const revisionStr = parts[5]!;

        return {
            version,
            major: parseInt(majorStr, 10),
            minor: parseInt(minorStr, 10),
            patch: parseInt(patchStr, 10),
            channel,
            revision: parseInt(revisionStr, 10)
        };
    }

    private static needsGlobSearch(version: string): boolean {
        return /\.x($|[^\w])/.test(version) || /\.\*($|[^\w])/.test(version) || !UnityVersion.UNITY_RELEASE_PATTERN.test(version);
    }

    private static resolveVersionCandidates(
        version: string,
        releases: UnityReleaseInfo[],
        channels: string[] = ['f']
    ): UnityReleaseInfo[] {
        const match = UnityVersion.VERSION_TOKEN_PATTERN.exec(version);

        if (!match) {
            Logger.instance.warn(`Invalid version pattern: ${version}`);
            return [];
        }

        const [, majorToken, minorToken] = match;
        const majorValue = majorToken ? parseInt(majorToken, 10) : Number.NaN;
        const normalizedMajor = Number.isNaN(majorValue) ? undefined : majorValue;
        const requestedMinor = UnityVersion.parseMinorToken(minorToken);

        let candidates = UnityVersion.filterFinalReleases(releases, normalizedMajor, requestedMinor, channels);

        if (!candidates.length && minorToken === '0') {
            candidates = UnityVersion.filterFinalReleases(releases, normalizedMajor, undefined, channels);
        }

        Logger.instance.debug(`Found ${candidates.length} candidate(s) for version pattern ${version}`);
        candidates.forEach(release => {
            Logger.instance.debug(`  - ${release.version}`);
        });

        return candidates.sort(UnityVersion.compareFinalReleaseInfo);
    }

    private static parseMinorToken(token: string | undefined): number | undefined {
        if (!token || token === 'x' || token === '*') {
            return undefined;
        }

        const value = parseInt(token, 10);
        return Number.isNaN(value) ? undefined : value;
    }

    private static filterFinalReleases(
        releases: UnityReleaseInfo[],
        major: number | undefined,
        minor?: number,
        channels: string[] = ['f']
    ): UnityReleaseInfo[] {
        return releases.filter(release =>
            channels.includes(release.channel) &&
            (major === undefined || release.major === major) &&
            (minor === undefined || release.minor === minor)
        );
    }

    private static compareFinalReleaseInfo(a: UnityReleaseInfo, b: UnityReleaseInfo): number {
        if (a.minor !== b.minor) { return b.minor - a.minor; }
        if (a.patch !== b.patch) { return b.patch - a.patch; }
        if (a.revision !== b.revision) { return b.revision - a.revision; }
        // compare channels in reverse order (f > p > b > a)
        return (UnityVersion.UNITY_CHANNEL_ORDER[b.channel] ?? Number.MAX_SAFE_INTEGER) -
            (UnityVersion.UNITY_CHANNEL_ORDER[a.channel] ?? Number.MAX_SAFE_INTEGER);
    }
}