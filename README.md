# unity-cli

[![Discord](https://img.shields.io/discord/855294214065487932.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/xQgMW9ufN4) [![NPM Version](https://img.shields.io/npm/v/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli) [![NPM Downloads](https://img.shields.io/npm/dw/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli)

> [!WARNING]
> This package is in maintenance mode.

A thin companion to Unity's official CLI (`unity`) for CI/CD pipelines. v4 installs and wraps the official CLI and only bridges what it does not cover yet.

## Maintenance

In unity's infinite wisdom, they decided to rip off yet another one of my open source projects with a clone of their own. which has blessed me with more free time and ability to work on other projects. As always, I build these kinds of tools because there is a gap in tooling or some need of mine to fulfil. I only wish that one day I get credit for the hard work I've been doing over the last 20 years to bring games and joy to people's lives.

v4 is the last feature release. The repository stays open for security and crash fixes only, and there are no new commands. `@rage-against-the-pixel/unity-cli` v3 and v4 stay on npm.

Use Unity's official CLI for everything it covers. See [Use the Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli). That includes Hub-free editor installs and uninstalls, modules, project create and open, templates, builds, tests, serial, floating and offline licenses, and service-account auth. See [unity-cli vs the official Unity CLI](docs/official-unity-cli-comparison.md) for what each tool covers and why unity-cli still exists for older Unity versions.
unity-cli v4 still covers:

- Installing the official Unity CLI on first use, with SHA-256 verification, for CI runners.
- Installing the Unity Package Manager CLI and packing signed packages with it.
- License activation and return with a Unity ID email and password, used when the official CLI cannot activate, such as a personal license on a headless runner.
- Unity 4.x and 5.x editors: installs from Unity's archives and the license file those editors read.
- Android target SDK setup for a project.
- Live Editor log and Unity Test Protocol output turned into GitHub Actions annotations, log groups and job summaries.

Send feature requests that the official CLI already covers to Unity.

> [!IMPORTANT]
> The documented commands can download, install, or run software from Unity (the Unity CLI, Editor, licensing tools, and similar binaries from Unity CDNs or services). That use is covered by Unity’s [Terms of Service](https://unity.com/legal/terms-of-service), the [Unity Editor Software Additional Terms](https://unity.com/legal/terms-of-service/software), and any other [Additional Terms](https://unity.com/legal/additional-terms) that apply to the offerings you use. Keep your Unity account, seats, and subscriptions in order, and read the agreements that actually bind you before relying on automation in CI or production. The full legal index is at [Unity Legal](https://unity.com/legal).
>
> Unity, Unity Hub, Unity Editor, and related names and logos are trademarks and other intellectual property of Unity Technologies Inc. and its affiliates. This project is independent and not affiliated with Unity. Names are used here only to describe what the commands talk to. If you ship Unity marks, artwork, or binaries, use Unity’s guidance, including their [IP policy](https://unity.com/legal/ip-policy-takedown-requests).

## Table of Contents

- [Maintenance](#maintenance)
- [Upgrading from v3](#upgrading-from-v3)
- [Unity version support](docs/unity-version-support.md)
- [unity-cli vs the official Unity CLI](docs/official-unity-cli-comparison.md)
- [Installation](#installation)
- [Usage](#usage)
  - [Common Commands](#common-commands)
  - [Official Unity CLI](#official-unity-cli)
  - [Auth](#auth)
    - [License Version](#license-version)
    - [Activate License](#activate-license)
    - [Return License](#return-license)
    - [License Context](#license-context)
    - [Licensing Client Logs](#licensing-client-logs)
    - [Licensing Audit Logs](#licensing-audit-logs)
  - [Unity Editor](#unity-editor)
    - [Setup Unity Editor](#setup-unity-editor)
    - [Run Unity Editor Commands](#run-unity-editor-commands)
    - [Unity Editor Logs](#unity-editor-logs)
  - [Deprecated Commands](#deprecated-commands)
  - [Unity Package Manager](#unity-package-manager)
    - [Install Unity Package Manager](#install-unity-package-manager)
    - [UPM Version](#upm-version)
    - [Pack a Unity Package](#pack-a-unity-package)
- [Logging](#logging)
  - [Local cli](#local-cli)
  - [Github Actions](#github-actions)

## Upgrading from v3

v4 drops the Hub. Commands that need the official CLI install it on first use.

| v3 command | v4 |
| --- | --- |
| `install-all-tools`, `hub-install` | Removed. The official CLI installs on first use, with no Hub needed |
| `hub`, `hub-path`, `hub-version`, `hub-logs`, `package-manager-logs` | Removed. Use `unity env`, `unity logs`, `unity doctor` |
| `sign-package` | Removed. Use `upm-pack` |
| `uninstall-unity` | Deprecated, same options, forwards to `unity uninstall <version> --yes` |
| `list-project-templates` | Deprecated, same options, forwards to `unity templates list --editor <version>` |
| `create-project` | Deprecated, same options, forwards to `unity projects create <name> --path <path> --editor-version <version> --template <id> --no-cloud` |
| `open-project` | Deprecated, same options, forwards to `unity open <project>` |
| `upm-install`, `upm-version`, `upm-pack` | Unchanged |

`setup-unity` exports `UNITY_CLI_PATH` instead of `UNITY_HUB_PATH`. Only the commands above are forwarded; unknown commands are not passed to `unity`.

## Installation

```bash
npm install -g @rage-against-the-pixel/unity-cli
```

> [!IMPORTANT]
> Requires Node v24 or higher.

## Usage

In general, the command structure is:

```bash
unity-cli [command] {options} <args...>
```

With options always using double dashes (`--option`) and arguments passed directly to Unity commands as they normally would with single dashes (`-arg`). Each option typically has a short alias using a single dash (`-o`), except for commands where we pass through arguments, as those get confused by the command parser.

### Common Commands

- `unity-cli --help` for a full list of commands and options.
- `unity-cli [command] --help` for details on a specific command.
- `unity-cli [command] --json` to get the output in JSON format (if supported).
- `unity-cli [command] --verbose <args...>` to enable verbose logging for debugging.

> [!IMPORTANT]
> `<args...>` must always be the last parameters passed to the command when using any command options.

```bash
unity-cli --help
```

### Official Unity CLI

Every command that needs the official Unity CLI installs it on first use. It downloads the latest release from Unity's CDN, checks the SHA-256 that Unity's release manifest lists, caches it in the runner tool cache (`unity-cli/<version>/<arch>`), adds it to the `PATH`, and exports `UNITY_CLI_PATH` and `UNITY_CLI_VERSION`. Later steps in the same job read `UNITY_CLI_VERSION` and reuse that copy. It also sets `UNITY_NON_INTERACTIVE`, `UNITY_NO_UPDATE_CHECK` and `UNITY_NO_CONSENT_PROMPT` so the CLI never prompts or updates itself mid-job.

To use a specific release, pass `--unity-cli-version <version>` to any command or set `UNITY_CLI_VERSION`:

```bash
unity-cli --unity-cli-version 1.0.0-beta.14 setup-unity --unity-version 6000
```

### Auth

Every license command tries the official Unity CLI first. When it fails, unity-cli falls back to `Unity.Licensing.Client` (the copy the official CLI downloads) with your Unity ID email and password. Unity 4.x and 5.x editors read their own license file, so when `UNITY_EDITOR_PATH` points at one of them, unity-cli uses the licensing client directly and patches it for that editor.

#### License Version

`license-version`: Print the Unity License Client version.

```bash
unity-cli license-version
```

##### Activate License

`activate-license [options]`: Activate a Unity license.

- `-l`, `--license`: License type (personal, professional, floating). Required.
- `-e`, `--email`: Email associated with the Unity account. Used when the official CLI cannot activate a personal or professional license. Defaults to `UNITY_USERNAME`.
- `-p`, `--password`: Password for the Unity account. Used when the official CLI cannot activate a personal or professional license. Defaults to `UNITY_PASSWORD`.
- `-s`, `--serial`: License serial number. Required when activating a professional license. Defaults to `UNITY_SERIAL`.
- `-f`, `--license-file`: A cached license file (`Unity_lic.ulf`) from an earlier activation on a machine with the same identity: a path, the raw XML, or base64. Defaults to `UNITY_LICENSE`. Falls back to the email and password when it cannot be used.
- `-c`, `--config`: Path to the configuration file, raw JSON, or base64 encoded JSON string. Required when activating a floating license.
- `--json`: Prints the last line of output as JSON string.
- `--verbose`: Enable verbose logging.

```bash
UNITY_USERNAME=<your-email> UNITY_PASSWORD=<your-password> unity-cli activate-license --license personal
```

> [!NOTE]
> Prefer the environment variables over `--email` and `--password`: values on a command line are visible to other processes on the machine. The Unity Licensing Client fallback still receives them as arguments, which Unity's client requires, so the official CLI stays the first choice.

##### Return License

`return-license [options]`: Return a Unity license.

- `-l`, `--license`: License type (personal, professional, floating)
- `-t`, `--token`: Floating license token from activation. When given, the floating license is returned with the Unity Licensing Client.
- `--when <auto|always|never>`: Defaults to `auto`, which skips returning a personal license on GitHub-hosted macOS and Linux runners. Those runners report one machine identity to Unity across every job and repository, so a return there revokes the license for all of them. Windows and self-hosted runners always return. Professional and floating licenses always return under `auto`, since a professional seat that is never returned stays taken. When a professional return is skipped (`never`) or fails, a warning points to id.unity.com > My Seats to release the seat by hand.
- `--verbose`: Enable verbose logging.

```bash
unity-cli return-license --license personal
```

#### License Context

`license-context`: Print the current license state from the official CLI and the Unity Licensing Client.

```bash
unity-cli license-context
```

#### License File Path

`license-file-path`: Prints the path to the machine's Unity license file (`Unity_lic.ulf`).

```bash
unity-cli license-file-path
```

#### Licensing Client Logs

`licensing-client-logs`: Prints the path to the Unity Licensing Client log file.

```bash
unity-cli licensing-client-logs
```

#### Licensing Audit Logs

`licensing-audit-logs`: Prints the path to the Unity Licensing Client audit log.

```bash
unity-cli licensing-audit-logs
```

### Unity Editor

#### Setup Unity Editor

`setup-unity [options]`: Find or install the Unity Editor for a project or specific version. 2017.4 and newer install with `unity install`. 5.x installs from Unity's download archive, because the official CLI reads one-digit majors as Unity 6 shorthand. 4.x installs from Unity's legacy installers on Windows and macOS.

- `-p`, `--unity-project <unityProject>` The path to a Unity project or `none` to skip project detection.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If specified, it will override the version read from the project.
- `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
- `--channel <channels>` Release channel letter(s) when resolving partial versions: `f`,`p`,`b`,`a`,`x` (comma-separated). Default: `f` (stable only). Partial versions fail closed if no match exists for the requested channel(s).
- `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
- `-b`, `--build-targets <buildTargets>` The Unity build target to get/install as comma-separated values (e.g. `iOS,Android`).
- `-m`, `--modules <modules>` The Unity module to get/install as comma-separated values (e.g. `ios,android`).
- `-i`, `--install-path <installPath>` The path to install the Unity Editor to. By default, it will be installed to the official CLI's install path.
- `--allow-security-alert` Install or select an editor that Unity marks with a Security Alert, with a warning instead of an error. Same as setting `UNITY_ALLOW_SECURITY_ALERT=1` (or `true`).
- `--verbose` Enable verbose logging.
- `--json` Prints the last line of output as JSON string.

With only `--unity-project`, it installs the modules for every build profile saved under the project's `Assets` folder (Unity 6 and newer). `--modules` or `--build-targets` replace that list.

For 2017 and newer, it checks the [Unity Releases API](https://services.docs.unity.com/release/v1/) for a Security Alert label on the exact release, whether the editor is installed already or not. A labelled release stops the setup before anything is downloaded, with Unity's own text, the advisory link and the newest stable release on the same `major.minor` without a label (or a note that Unity has no patched release on that branch, in which case the advisory covers the binary patch tool). On GitHub Actions this is an error annotation titled `Unity Security Alert`. With `--allow-security-alert` or `UNITY_ALLOW_SECURITY_ALERT`, the same text is a warning and the setup continues. When the official CLI already returns a security warning for the release, its text is printed instead. If the Releases API cannot be reached, it warns and continues.

4.x and 5.x are not in the Releases API, so every one of them gets a fixed Security Alert that needs the same opt-in: Unity publishes no security metadata for them and never patched them against later advisories. They stay installable for archival work and older games. The alert lists the known editor CVEs that reach the requested version, [CVE-2017-12939](https://nvd.nist.gov/vuln/detail/CVE-2017-12939) (all 4.x and 5.x before 5.3.8p2, 5.4.5p5, 5.5.4p3 and 5.6.3p1) and [CVE-2019-9197](https://nvd.nist.gov/vuln/detail/CVE-2019-9197) (5.6 before 5.6.7f1), and points to [Unity's security advisories](https://unity.com/security) when neither applies. `run` checks the same way when it installs a project's editor, with `UNITY_ALLOW_SECURITY_ALERT` as its opt-in.

It exports `UNITY_CLI_PATH`, `UNITY_EDITOR_PATH`, `UNITY_EDITOR_VERSION`, `UNITY_EDITOR_CHANGESET`, `UNITY_EDITOR_CHANNELS` and, with a project, `UNITY_PROJECT_PATH`. With a project and the `android` module, it also installs the project's Android target SDK.

Installs the latest Unity 6 version with Android and iOS modules:

```bash
unity-cli setup-unity --unity-version 6000 --modules android,ios
```

#### Run Unity Editor Commands

`run [options] <args...>`: Run Unity Editor command line arguments with live Editor log and Unity Test Protocol annotations.

Runs with a project go through the official CLI's `unity run` for 2019.1 and newer editors. Runs without a project, older editors, Linux runs that need `xvfb`, and x86_64 editors under Rosetta launch the editor directly. Set `UNITY_CLI_DIRECT_LAUNCH=true` to always launch the editor directly.

- `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `--unity-project` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable will be used, otherwise no project will be specified.
- `--log-name <logName>` The name of the log file.
- `--log-level <logLevel>` Override the logger verbosity (debug, info, minimal, warning, error). Defaults to info.
- `--verbose` Enable verbose logging. Deprecated, use `--log-level` instead.
- `<args...>` Arguments to pass directly to the Unity Editor executable.

> [!NOTE]
> When setting the `--log-level` option to `minimal`, only the unity telemetry logs will be shown in the console output. All other logs will be written to the log file. This option is only supported when running the command locally in the terminal. ***This options is still experimental and may change in future releases.***
>
> When running in CI environments the logger will automatically print the full logs to the console no matter the log level.

```bash
unity-cli run --unity-project <path-to-project> -quit -batchmode -executeMethod StartCommandLineBuild
```

#### Unity Editor Logs

`editor-logs`: Prints the path to the Unity Editor log files.

```bash
unity-cli editor-logs
```

### Deprecated Commands

`uninstall-unity`, `list-project-templates`, `create-project` and `open-project` keep their v3 options, print a deprecation warning that names the replacement, and forward to the official Unity CLI (see [Upgrading from v3](#upgrading-from-v3)). `create-project --template` takes a template id or id prefix; v3 regex patterns are no longer compiled, and only their leading literal part is matched. Run `unity-cli <command> --help` for the options.

### Unity Package Manager

Unity publishes the pack and sign tool as its own CLI. See [Unity Package Manager CLI workflow](https://docs.unity3d.com/Manual/upm-cli.html). The commands below call that same `upm` binary.

#### Install Unity Package Manager

`upm-install [options]`: Download and install the Unity Package Manager cli (pack/sign).

- `--auto-update`: Automatically updates the upm cli if it is already installed and a newer release is available. Cannot be used with `--version`.
- `--version <version>`: Specify to install a specific version of the Unity Package Manager cli. Cannot be used with `--auto-update`.
- `--json`: Print version and managed paths as JSON.
- `--verbose`: Enable verbose logging.

```bash
unity-cli upm-install --auto-update
```

#### UPM Version

`upm-version`: Print the Unity Package Manager cli version.

```bash
unity-cli upm-version
```

#### Pack a Unity Package

**Prerequisites:** In the [Unity Cloud Dashboard](https://cloud.unity.com/), create a **service account** on the organization you use for signing. When you assign **organization** access, open **Manage organization roles**, set the **Package Manager** role to **Package Manager Package Signer**, and save. Put the generated key id and secret in `UPM_SERVICE_ACCOUNT_KEY_ID` and `UPM_SERVICE_ACCOUNT_KEY_SECRET` (or your CI secret store). Copy **Organization ID** from **Administration** → **Settings** in that same org. If you have multiple orgs, switch to the correct one in the dashboard before creating keys or copying the id.

`upm-pack [options]`: Sign and pack a Unity package.

- `--source <path>`: An absolute or relative path to the root folder of the custom package to pack. This is the folder that contains the package manifest file (package.json). (optional; defaults to the current working directory).
- `--destination <path>`: The output path for the signed tarball. If you specify a folder that doesn’t exist, it will be created for you. Note: If you omit this parameter, the tarball will be placed in the current working directory.
- `--verbose`: Enable verbose logging.

> [!NOTE]
> Set `UNITY_ORGANIZATION_ID` or `UNITY_ORG_ID`, `UPM_SERVICE_ACCOUNT_KEY_ID`, and `UPM_SERVICE_ACCOUNT_KEY_SECRET`, or leave them unset in an interactive terminal to be prompted securely.

```bash
unity-cli upm-pack --source <path-to-package-folder> --destination <output-path>
```

## Logging

### Local cli

`unity-cli` keeps regular terminal runs simple:

- Writes everything to `stdout` with ANSI colors (yellow warnings, red errors) so you can scan logs quickly.
- `startGroup`/`endGroup` just print headers and content, and don't include any foldouts or collapsing behavior and is meant for CI environments only.

### Github Actions

When `GITHUB_ACTIONS=true`, the logger emits GitHub workflow commands automatically:

- Defaults to `info` level; add `--verbose` (or temporarily set `ACTIONS_STEP_DEBUG=true`) to surface `debug` lines.
- `Logger.annotate(...)` escapes `%`, `\r`, and `\n`, then includes `file`, `line`, `endLine`, `col`, `endColumn`, and `title` metadata so annotations are clickable in the Checks UI.
- `startGroup`/`endGroup` become `::group::` / `::endgroup::` blocks.
- `CI_mask`, `CI_setEnvironmentVariable`, `CI_setOutput` and `CI_addPath` write to the corresponding GitHub-provided files when those features are configured.
- **Job summary (`GITHUB_STEP_SUMMARY`) is opt-in:** set `UNITY_CLI_WORKFLOW_SUMMARY` to `1`, `true`, `yes`, or `on` (case-insensitive) so `CI_appendWorkflowSummary` can append the rich markdown block from Unity log / UTP parsing. If unset, summary output is skipped (annotations and stdout behavior are unchanged).

The same command line you run locally therefore produces colorized console output on your machine and rich annotations once it runs inside Actions.
