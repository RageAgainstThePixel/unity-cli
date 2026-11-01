import { Logger, LogLevel } from './logging';
import { UnityVersion } from './unity-version';
import {
    UnityReleasesClient,
    GetUnityReleasesData,
    UnityRelease,
} from '@rage-against-the-pixel/unity-releases-api';

/** Annotation title for a Unity Security Alert, as an error without the opt-in and a warning with it. */
export const SECURITY_ALERT_TITLE = 'Unity Security Alert';

/** The Releases API's largest page, and a bound on the pages read for one branch. */
const PAGE_SIZE = 25;
const MAX_BRANCH_PAGES = 20;

/** The environment variable that opts in to installing or selecting an editor with a security alert. */
export const SECURITY_ALERT_ENV = 'UNITY_ALLOW_SECURITY_ALERT';

/**
 * The `label` the Unity Releases API puts on a release, such as the Security Alert on editors with a known issue.
 * The releases API client types do not include it yet.
 */
export interface UnityReleaseLabel {
    labelText?: string;
    icon?: string;
    color?: string;
    description?: string;
}

/** A Unity Security Alert for one release: Unity's own text, and the release to move to. */
export interface UnitySecurityAlert {
    version: string;
    message: string;
    suggestion: string;
}

/** Thrown when an editor has a Unity Security Alert and the opt-in was not given. */
export class UnitySecurityAlertError extends Error {
    public readonly title = SECURITY_ALERT_TITLE;

    constructor(message: string) {
        super(message);
        this.name = 'UnitySecurityAlertError';
    }
}

/**
 * Whether UNITY_ALLOW_SECURITY_ALERT opts in to editors with a security alert.
 * @returns true when it is 1 or true, ignoring case.
 */
export function IsSecurityAlertAllowedByEnv(): boolean {
    const value = process.env[SECURITY_ALERT_ENV]?.trim().toLowerCase();
    return value === '1' || value === 'true';
}

/**
 * Whether a release label is a security alert: Security in its text, or Unity's error color.
 * @param label The release's label, if any.
 */
export function IsSecurityLabel(label: UnityReleaseLabel | undefined | null): boolean {
    if (!label || typeof label !== 'object') {
        return false;
    }

    return (typeof label.labelText === 'string' && /security/i.test(label.labelText)) ||
        (typeof label.color === 'string' && label.color.toUpperCase() === 'ERROR');
}

/**
 * Turns a label description into plain text and the links it carries. Tags are dropped and their text kept,
 * so Unity's own wording prints as it is; only https links are returned.
 * @param description The label's HTML description.
 */
export function ParseLabelDescription(description: string | undefined): { text: string; links: string[] } {
    if (!description) {
        return { text: '', links: [] };
    }

    const links: string[] = [];
    let text = '';
    let index = 0;

    while (index < description.length) {
        const char = description[index]!;

        if (char !== '<') {
            text += char;
            index++;
            continue;
        }

        const end = description.indexOf('>', index);

        if (end === -1) {
            break;
        }

        const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(description.slice(index, end));

        if (href?.[1] && /^https:\/\/[^\s]+$/i.test(href[1]) && !links.includes(href[1])) {
            links.push(href[1]);
        }

        index = end + 1;
    }

    // &amp; last, so an escaped entity such as &amp;lt; is not decoded twice
    text = text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
    return { text: sanitizeText(text), links };
}

/**
 * Reads the text of a warning from the official Unity CLI's JSON `warnings`.
 * @param warning One entry of the envelope's `warnings`.
 */
export function FormatCliWarning(warning: unknown): string {
    if (typeof warning === 'string') {
        return sanitizeText(warning);
    }

    if (warning && typeof warning === 'object') {
        const record = warning as { code?: unknown; message?: unknown };

        if (typeof record.message === 'string') {
            return sanitizeText(typeof record.code === 'string' && record.code.length > 0 ? `${record.code}: ${record.message}` : record.message);
        }
    }

    return sanitizeText(JSON.stringify(warning) ?? '');
}

/**
 * Whether a warning from the official Unity CLI is a security warning.
 * @param warning One entry of the envelope's `warnings`.
 */
export function IsSecurityCliWarning(warning: unknown): boolean {
    return /security/i.test(FormatCliWarning(warning));
}

/**
 * Checks the Unity Releases API for a Unity Security Alert on an exact release.
 * 4.x and 5.x are skipped, since the API lists only 2017 and newer. When the API cannot be reached, a warning is
 * logged and the check passes, so an outage does not stop installs.
 * @param unityVersion The exact release.
 * @returns The alert, or undefined when the release has none or could not be checked.
 */
export async function GetUnitySecurityAlert(unityVersion: UnityVersion): Promise<UnitySecurityAlert | undefined> {
    const logger = Logger.instance;

    if (unityVersion.isLessThan('2017.0.0') || !unityVersion.isFullyQualified()) {
        return undefined;
    }

    let label: UnityReleaseLabel | undefined;

    try {
        const release = await findRelease(unityVersion);

        if (!release) {
            throw new Error(`Unity ${unityVersion.version} is not listed`);
        }

        label = (release as unknown as { label?: UnityReleaseLabel | null }).label ?? undefined;
    } catch (error) {
        logger.warn(`could not check Unity security status for ${unityVersion.version}: ${error instanceof Error ? error.message : error}`);
        return undefined;
    }

    if (!IsSecurityLabel(label)) {
        return undefined;
    }

    const { text, links } = ParseLabelDescription(label!.description);
    const lines = [`Unity ${unityVersion.version} has a Unity ${sanitizeText(label!.labelText ?? 'Security Alert')}.`];

    if (text.length > 0) {
        lines.push(text);
    }

    for (const link of links) {
        lines.push(`Advisory: ${link}`);
    }

    return { version: unityVersion.version, message: lines.join('\n'), suggestion: await getSuggestion(unityVersion, links) };
}

/** Known Unity Editor CVEs that affect 4.x and 5.x, with the first fixed release of each 5.x line. */
const LEGACY_EDITOR_CVES: {
    id: string;
    summary: string;
    /** The lines it reaches; a line without a fixed release is affected throughout. */
    affects: (major: number, minor: number) => boolean;
    fixed: { [line: string]: string };
}[] = [
    {
        id: 'CVE-2017-12939',
        summary: 'Windows editor remote code execution',
        affects: (major) => major === 4 || major === 5,
        fixed: { '5.3': '5.3.8p2', '5.4': '5.4.5p5', '5.5': '5.5.4p3', '5.6': '5.6.3p1' },
    },
    {
        id: 'CVE-2019-9197',
        summary: 'editor remote code execution through unvalidated input',
        affects: (major, minor) => major === 5 && minor === 6,
        fixed: { '5.6': '5.6.7f1' },
    },
];

/**
 * The fixed Unity Security Alert for 4.x and 5.x editors, which the Releases API does not list. Unity publishes no
 * security metadata for them and never patched them, so every one needs the opt-in; the text names the known editor
 * CVEs that reach the requested version.
 * @param unityVersion A 4.x or 5.x version, with or without its channel, such as 4.7.2 or 5.6.7f1.
 * @returns The alert, or undefined for 2017 and newer.
 */
export function GetLegacySecurityAlert(unityVersion: UnityVersion): UnitySecurityAlert | undefined {
    const parsed = parseLegacyVersion(unityVersion.version);

    if (!parsed || parsed.major > 5) {
        return undefined;
    }

    const cves = LEGACY_EDITOR_CVES.filter(cve => {
        if (!cve.affects(parsed.major, parsed.minor)) {
            return false;
        }

        const fixed = cve.fixed[`${parsed.major}.${parsed.minor}`];
        return !fixed || compareLegacyVersions(parsed, parseLegacyVersion(fixed)!) < 0;
    });
    const lines = [
        `Unity ${unityVersion.version} has a Unity Security Alert.`,
        'Unity publishes no security metadata for 4.x and 5.x editors and never patched them against later advisories. They are kept for archival work and older games.',
    ];

    if (cves.length > 0) {
        lines.push(`Known editor CVEs for Unity ${unityVersion.version}:`);

        for (const cve of cves) {
            const fixed = cve.fixed[`${parsed.major}.${parsed.minor}`];
            lines.push(`- ${cve.id}: ${cve.summary}${fixed ? `, fixed in ${fixed}` : ', never fixed on this line'}. https://nvd.nist.gov/vuln/detail/${cve.id}`);
        }
    } else {
        lines.push('No editor CVE names this exact version, but it is unsupported and unpatched against later Unity security advisories.');
    }

    lines.push('Advisories: https://unity.com/security');
    return {
        version: unityVersion.version,
        message: lines.join('\n'),
        suggestion: 'Unity has no patched 4.x or 5.x release.',
    };
}

interface LegacyVersion { major: number; minor: number; patch: number; channel: string; build: number }

function parseLegacyVersion(version: string): LegacyVersion | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:([abcfpx])(\d+))?$/.exec(version);

    if (!match) {
        return undefined;
    }

    return {
        major: parseInt(match[1]!, 10),
        minor: parseInt(match[2]!, 10),
        patch: parseInt(match[3]!, 10),
        channel: match[4] ?? 'f',
        build: match[5] ? parseInt(match[5], 10) : 0,
    };
}

/** Orders releases the way Unity ships them: on one patch number, alphas and betas, then the final release, then its patch releases. */
function compareLegacyVersions(a: LegacyVersion, b: LegacyVersion): number {
    const rank: { [channel: string]: number } = { a: 0, b: 1, c: 2, x: 2, f: 3, p: 4 };
    return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch) ||
        ((rank[a.channel] ?? 3) - (rank[b.channel] ?? 3)) || (a.build - b.build);
}

/**
 * Reports a Unity Security Alert: a warning annotation with the opt-in, otherwise an error that stops the setup.
 * @param unityVersion The release the alert is for.
 * @param alertText The alert text, from the Releases API or the official CLI.
 * @param allow Whether --allow-security-alert or UNITY_ALLOW_SECURITY_ALERT was given.
 */
export function ReportUnitySecurityAlert(unityVersion: UnityVersion, alertText: string, allow: boolean): void {
    if (allow) {
        Logger.instance.annotate(LogLevel.WARN, `${alertText}\nContinuing, since the security alert was allowed.`, undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE);
        return;
    }

    throw new UnitySecurityAlertError(`${alertText}\nTo use Unity ${unityVersion.version} anyway, pass --allow-security-alert or set ${SECURITY_ALERT_ENV}=1.`);
}

/**
 * Suggests the newest stable release on the same major.minor without a label, or says there is none.
 */
async function getSuggestion(unityVersion: UnityVersion, links: string[]): Promise<string> {
    const [major, minor] = unityVersion.version.split('.');
    const branch = `${major}.${minor}`;
    const releases: UnityRelease[] = [];

    try {
        // every page, so "no patched release" is never claimed from the first 25 rows alone
        for (let page = 0; page < MAX_BRANCH_PAGES; page++) {
            const results = await getReleases({
                version: branch,
                architecture: [unityVersion.architecture],
                platform: getPlatform(),
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
                order: 'RELEASE_DATE_DESC',
            });
            releases.push(...results);

            if (results.length < PAGE_SIZE) {
                break;
            }
        }
    } catch (error) {
        Logger.instance.debug(`Could not look up a patched Unity ${branch} release: ${error}`);
        return `Update to a Unity ${branch} release without a security alert.`;
    }

    const patched = releases
        .filter(release => typeof release.version === 'string' && /^\d+\.\d+\.\d+f\d+$/.test(release.version) && release.version.startsWith(`${branch}.`))
        .filter(release => !(release as unknown as { label?: UnityReleaseLabel | null }).label)
        .map(release => new UnityVersion(release.version!, release.shortRevision, unityVersion.architecture))
        .sort((a, b) => UnityVersion.compare(b, a))[0];

    if (patched) {
        return `Suggested: Unity ${patched.version}, the newest stable ${branch} release without a security alert.`;
    }

    const advisory = links.length > 0 ? ` See the advisory for the binary patch tool: ${links[0]}` : ' See the advisory for the binary patch tool.';
    return `Unity has no patched release on the ${branch} branch.${advisory}`;
}

async function findRelease(unityVersion: UnityVersion): Promise<UnityRelease | undefined> {
    const releases = await getReleases({ version: unityVersion.version, limit: 5 });
    return releases.find(release => release.version === unityVersion.version);
}

async function getReleases(query: NonNullable<GetUnityReleasesData['query']>): Promise<UnityRelease[]> {
    const releasesClient = new UnityReleasesClient();
    const { data, error } = await releasesClient.api.Release.getUnityReleases({
        url: '/unity/editor/release/v1/releases',
        query,
    } as GetUnityReleasesData);

    if (error) {
        throw new Error(`the Unity Releases API returned ${JSON.stringify(error)}`);
    }

    return data?.results ?? [];
}

function getPlatform(): Array<'MAC_OS' | 'LINUX' | 'WINDOWS'> {
    switch (process.platform) {
        case 'darwin':
            return ['MAC_OS'];
        case 'win32':
            return ['WINDOWS'];
        default:
            return ['LINUX'];
    }
}

/** Drops control characters, so text from the API or the CLI cannot move the cursor or recolor the log. */
function sanitizeText(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
}
