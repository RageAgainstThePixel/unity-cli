# unity-cli

[![Discord](https://img.shields.io/discord/855294214065487932.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/xQgMW9ufN4) [![NPM Version](https://img.shields.io/npm/v/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli) [![NPM Downloads](https://img.shields.io/npm/dw/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli)

> [!WARNING]
> This package is in maintenance mode.

A thin companion to Unity's official CLI (`unity`) for CI/CD pipelines. v4 installs and wraps the official CLI and only bridges what it does not cover yet.

## Maintenance

In unity's infinite wisdom, they decided to rip off yet another one of my open source projects with a clone of their own. which has blessed me with more free time and ability to work on other projects. As always, I build these kinds of tools because there is a gap in tooling or some need of mine to fulfil. I only wish that one day I get credit for the hard work I've been doing over the last 20 years to bring games and joy to people's lives.

v4 is the last feature release. The repository stays open for security and crash fixes only, and there are no new commands. `@rage-against-the-pixel/unity-cli` v3 and v4 stay on npm.

Use Unity's official CLI for everything it covers. See [Use the Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli). That includes Hub-free editor installs and uninstalls, modules, project create and open, templates, builds, tests, serial, floating and offline licenses, and service-account auth. Pack and sign UPM packages with Unity's [Unity Package Manager CLI](https://docs.unity3d.com/Manual/upm-cli.html).

unity-cli v4 still covers:

- Installing and pinning the official Unity CLI, with SHA-256 verification, for CI runners.
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
- [Installation](#installation)
- [Usage](#usage)
  - [Common Commands](#common-commands)
  - [Setup Unity CLI](#setup-unity-cli)
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
- [Logging](#logging)
  - [Local cli](#local-cli)
  - [Github Actions](#github-actions)

## Upgrading from v3

v4 removes the commands the official CLI covers. Call `unity` for them instead.

| v3 command | v4 replacement |
| --- | --- |
| `install-all-tools`, `hub-install` | `unity-cli setup-cli` (no Hub needed) |
| `hub`, `hub-path`, `hub-version`, `hub-logs`, `package-manager-logs` | `unity env`, `unity logs`, `unity doctor` |
| `uninstall-unity` | `unity uninstall <version> --yes` |
| `list-project-templates` | `unity templates list --editor <version>` |
| `create-project` | `unity projects create <name> --editor-version <version> --template <id> --no-cloud` |
| `open-project` | `unity open` |
| `upm-install`, `upm-version`, `upm-pack`, `sign-package` | Unity's [Package Manager CLI](https://docs.unity3d.com/Manual/upm-cli.html) |

`setup-unity` exports `UNITY_CLI_PATH` instead of `UNITY_HUB_PATH`. Unknown commands are not forwarded to `unity`.

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

### Setup Unity CLI

`setup-cli [options]`: Install the official Unity CLI, or reuse it when the requested version is already installed. It downloads the exact release from Unity's CDN, checks its SHA-256, caches it in the runner tool cache (`unity-cli/<version>/<arch>`), adds it to the `PATH`, and exports `UNITY_CLI_PATH` and `UNITY_CLI_VERSION`. It also sets `UNITY_NON_INTERACTIVE`, `UNITY_NO_UPDATE_CHECK` and `UNITY_NO_CONSENT_PROMPT` so the CLI never prompts or updates itself mid-job.

- `--unity-cli-version <version>`: An exact official Unity CLI version (e.g. `1.0.0-beta.14`) or `latest`. Defaults to an installed CLI, then the version unity-cli is tested against.
- `--verbose`: Enable verbose logging.
- `--json`: Prints the last line of output as JSON string.

```bash
unity-cli setup-cli --unity-cli-version 1.0.0-beta.14
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
- `--unity-cli-version <version>` The official Unity CLI version to install when it is missing.
- `--verbose` Enable verbose logging.
- `--json` Prints the last line of output as JSON string.

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
