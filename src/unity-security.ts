import { Logger, LogLevel } from './logging';
import { UnityVersion } from './unity-version';
import {
    UnityReleasesClient,
    GetUnityReleasesData,
    UnityRelease,
} from '@rage-against-the-pixel/unity-releases-api';

/** Annotation title for a Unity Security Alert, as an error without the opt-in and a warning with it. */
export const SECURITY_ALERT_TITLE = 'Unity Security Alert';

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
    let releases: UnityRelease[];

    try {
        releases = await getReleases({
            version: branch,
            architecture: [unityVersion.architecture],
            platform: getPlatform(),
            limit: 25,
            order: 'RELEASE_DATE_DESC',
        });
    } catch (error) {
        Logger.instance.debug(`Could not look up a patched Unity ${branch} release: ${error}`);
        return `Update to a newer Unity ${branch} release without a security alert.`;
    }

    const patched = releases
        .filter(release => typeof release.version === 'string' && /^\d+\.\d+\.\d+f\d+$/.test(release.version) && release.version.startsWith(`${branch}.`))
        .filter(release => !(release as unknown as { label?: UnityReleaseLabel | null }).label)
        .map(release => new UnityVersion(release.version!, release.shortRevision, unityVersion.architecture))
        .filter(version => UnityVersion.compare(version, unityVersion) > 0)
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
