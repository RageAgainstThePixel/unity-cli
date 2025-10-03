import * as os from 'os';
import { Logger } from './logging';
import {
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
        const baseComparison = compare(a.semVer, b.semVer, true);

        if (baseComparison !== 0) {
            return baseComparison;
        }

        return UnityVersion.compareBuildMetadata(a.semVer, b.semVer);
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

    findMatch(versions: string[]): UnityVersion {
        const releaseInfos = UnityVersion.extractReleaseVersions(versions);
        const releaseMap = new Map(releaseInfos.map(info => [info.version, info]));
        const exactMatch = releaseMap.get(this.version);

        if (exactMatch) {
            this.logger.debug(`Exact match found for ${this.version}`);
            return new UnityVersion(exactMatch.version, this.changeset ?? null, this.architecture);
        }

        if (UnityVersion.needsFallbackSearch(this.version)) {
            const candidates = UnityVersion.resolveFallbackCandidates(this.version, releaseInfos);

            this.logger.debug(`Searching for fallback match for ${this.version}:`);
            candidates.forEach(release => {
                this.logger.debug(`  > ${release.version}`);
            });

            const latest = candidates[0];

            if (latest) {
                this.logger.debug(`Found fallback Unity ${latest.version}`);
                return new UnityVersion(latest.version, null, this.architecture);
            }
        }

        this.logger.debug(`No matching Unity version found for ${this.version}`);
        return this;
    }

    satisfies(version: string): boolean {
        const coercedVersion = coerce(version);

        if (!coercedVersion) {
            throw new Error(`Invalid version to check against: ${version}`);
        }

        return satisfies(coercedVersion, `^${this.semVer.version}`);
    }

    private static readonly UNITY_RELEASE_PATTERN = /^(\d{1,4})\.(\d+)\.(\d+)([abcfpx])(\d+)$/;
    private static readonly VERSION_TOKEN_PATTERN = /^(\d{1,4})(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/;

    private static readonly UNITY_CHANNEL_ORDER: Record<string, number> = {
        a: 0,
        b: 1,
        c: 2,
        f: 3,
        p: 4,
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

    private static extractReleaseVersions(versions: string[]): UnityReleaseInfo[] {
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

    private static parseReleaseInfo(release: string): UnityReleaseInfo | null {
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

    private static needsFallbackSearch(version: string): boolean {
        return /\.x($|[^\w])/.test(version) || /\.\*($|[^\w])/.test(version) || !UnityVersion.UNITY_RELEASE_PATTERN.test(version);
    }

    private static resolveFallbackCandidates(
        version: string,
        releases: UnityReleaseInfo[]
    ): UnityReleaseInfo[] {
        const match = UnityVersion.VERSION_TOKEN_PATTERN.exec(version);

        if (!match) {
            return [];
        }

        const [, majorToken, minorToken] = match;
        const majorValue = majorToken ? parseInt(majorToken, 10) : Number.NaN;
        const normalizedMajor = Number.isNaN(majorValue) ? undefined : majorValue;
        const requestedMinor = UnityVersion.parseMinorToken(minorToken);

        let candidates = UnityVersion.filterFinalReleases(releases, normalizedMajor, requestedMinor);

        if (!candidates.length && minorToken === '0') {
            candidates = UnityVersion.filterFinalReleases(releases, normalizedMajor);
        }

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
        minor?: number
    ): UnityReleaseInfo[] {
        return releases.filter(release =>
            release.channel === 'f' &&
            (major === undefined || release.major === major) &&
            (minor === undefined || release.minor === minor)
        );
    }

    private static compareFinalReleaseInfo(a: UnityReleaseInfo, b: UnityReleaseInfo): number {
        if (a.minor !== b.minor) { return b.minor - a.minor; }
        if (a.patch !== b.patch) { return b.patch - a.patch; }
        return b.revision - a.revision;
    }
}