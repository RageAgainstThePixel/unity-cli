# unity-cli

[![Discord](https://img.shields.io/discord/855294214065487932.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/xQgMW9ufN4) [![NPM Version](https://img.shields.io/npm/v/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli) [![NPM Downloads](https://img.shields.io/npm/dw/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli)

A powerful command line utility for the Unity Game Engine. Automate Unity project setup, editor installation, license management, building, and more—ideal for CI/CD pipelines and developer workflows.

> [!IMPORTANT]
> The documented commands can download, install, or run software from Unity (Hub, Editor, Package Manager CLI, licensing tools, and similar binaries from Unity CDNs or services). That use is covered by Unity’s [Terms of Service](https://unity.com/legal/terms-of-service), the [Unity Editor Software Additional Terms](https://unity.com/legal/terms-of-service/software), and any other [Additional Terms](https://unity.com/legal/additional-terms) that apply to the offerings you use. Keep your Unity account, seats, and subscriptions in order, and read the agreements that actually bind you before relying on automation in CI or production. The full legal index is at [Unity Legal](https://unity.com/legal).
>
> Unity, Unity Hub, Unity Editor, and related names and logos are trademarks and other intellectual property of Unity Technologies Inc. and its affiliates. This project is independent and not affiliated with Unity. Names are used here only to describe what the commands talk to. If you ship Unity marks, artwork, or binaries, use Unity’s guidance, including their [IP policy](https://unity.com/legal/ip-policy-takedown-requests).

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Common Commands](#common-commands)
  - [Install all tools](#install-all-tools)
  - [Auth](#auth)
    - [License Version](#license-version)
    - [Activate License](#activate-license)
    - [Return License](#return-license)
    - [License Context](#license-context)
    - [Licensing Client Logs](#licensing-client-logs)
    - [Licensing Audit Logs](#licensing-audit-logs)
  - [Unity Hub](#unity-hub)
    - [Hub Version](#hub-version)
    - [Hub Path](#hub-path)
    - [Hub Logs](#hub-logs)
    - [Package Manager Logs](#package-manager-logs)
    - [Unity Hub Install](#unity-hub-install)
    - [Run Unity Hub Commands](#run-unity-hub-commands)
    - [Setup Unity Editor](#setup-unity-editor)
    - [Uninstall Unity Editor](#uninstall-unity-editor)
  - [Unity Editor](#unity-editor)
    - [Run Unity Editor Commands](#run-unity-editor-commands)
    - [List Project Templates](#list-project-templates)
    - [Create Unity Project](#create-unity-project)
    - [Open Unity Project](#open-unity-project)
    - [Unity Editor Logs](#unity-editor-logs)
  - [Unity Package Manager](#unity-package-manager)
    - [Install Unity Package Manager](#install-unity-package-manager)
    - [UPM Version](#upm-version)
    - [Pack a Unity Package](#pack-a-unity-package)
    - [Deprecated Sign Package Command](#deprecated-sign-package-command)
- [Logging](#logging)
  - [Local cli](#local-cli)
  - [Github Actions](#github-actions)

## Features

- Install and manage Unity Hub and Unity Editors (multi-platform)
- Activate and return Unity licenses (personal, professional, floating)
- Create new Unity projects from templates
- Run Unity Editor commands and builds from the CLI
- Supports all modules, architectures, and build targets
- Works on Windows, macOS, and Linux
- Designed for automation and CI/CD

## Installation

```bash
npm install -g @rage-against-the-pixel/unity-cli
```

> [!IMPORTANT]
> Requires Node v22.12 or higher.

## Usage

In general, the command structure is:

```bash
unity-cli [command] {options} <args...>
```

With options always using double dashes (`--option`) and arguments passed directly to Unity or Unity Hub commands as they normally would with single dashes (`-arg`). Each option typically has a short alias using a single dash (`-o`), except for commands where we pass through arguments, as those get confused by the command parser.

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

### Install all tools

`install-all-tools` runs Unity Hub installation and managed UPM CLI installation together (the same work as `hub-install` and `upm-install` in parallel). Use `unity-cli install-all-tools --help` for `--hub-version`, `--upm-version`, `--auto-update`, `--json`, and `--verbose`.

```bash
unity-cli install-all-tools --auto-update
```

### Auth

#### License Version

`license-version`: Print the Unity License Client version.

```bash
unity-cli license-version
```

##### Activate License

`activate-license [options]`: Activate a Unity license.

- `-l`, `--license`: License type (personal, professional, floating). Required.
- `-e`, `--email`: Email associated with the Unity account. Required when activating a personal or professional license.
- `-p`, `--password`: Password for the Unity account. Required when activating a personal or professional license.
- `-s`, `--serial`: License serial number. Required when activating a professional license.
- `-c`, `--config`: Path to the configuration file, raw JSON, or base64 encoded JSON string. Required when activating a floating license.
- `--json`: Prints the last line of output as JSON string.
- `--verbose`: Enable verbose output.

```bash
unity-cli activate-license --license personal --email <your-email> --password <your-password>
```

##### Return License

`return-license [options]`: Return a Unity license.

- `-l`, `--license`: License type (personal, professional, floating)
- `-t`, `--token`: Floating license token. Required when returning a floating license.
- `--verbose`: Enable verbose output.

```bash
unity-cli return-license --license personal
```

#### License Context

`license-context`: Prints the current license context information.

```bash
unity-cli license-context
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

### Unity Hub

#### Hub Version

`hub-version`: Print the Unity Hub version.

```bash
unity-cli hub-version
```

#### Hub Path

`hub-path`: Print the Unity Hub executable path.

```bash
unity-cli hub-path
```

#### Hub Logs

`hub-logs`: Prints the path to the Unity Hub log file.

```bash
unity-cli hub-logs
```

#### Package Manager Logs

`package-manager-logs`: Prints the path to the Unity Package Manager log file.

```bash
unity-cli package-manager-logs
```

#### Unity Hub Install

`hub-install [options]`: Install or update the Unity Hub

- `--auto-update`: Automatically updates the Unity Hub if it is already installed. Cannot be used with `--hub-version`.
- `--hub-version`: Specify to install a specific version of Unity Hub. Cannot be used with `--auto-update`.
- `--verbose`: Enable verbose output.
- `--json`: Output installation information in JSON format.

```bash
unity-cli hub-install
```

#### Run Unity Hub Commands

`hub [options] <args...>`: Run Unity Hub command line arguments (passes args directly to the hub executable).

- `--verbose`: Enable verbose output.
- `--json`: Prints the last line of output as a json string, which contains the operation results.
- `<args...>`: Arguments to pass directly to the Unity Hub executable.

Lists available Unity Hub commands:

```bash
unity-cli --verbose hub help
```

Gets a list of installed editors:

```bash
unity-cli hub editors --installed
```

#### Setup Unity Editor

`setup-unity [options]`: Find or install the Unity Editor for a project or specific version.

- `-p`, `--unity-project <unityProject>` The path to a Unity project or `none` to skip project detection.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If specified, it will override the version read from the project.
- `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
- `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
- `-b`, `--build-targets <buildTargets>` The Unity build target to get/install as comma-separated values (e.g. `iOS,Android`).
- `-m`, `--modules <modules>` The Unity module to get/install as comma-separated values (e.g. `ios,android`).
- `-i`, `--install-path <installPath>` The path to install the Unity Editor to. By default, it will be installed to the default Unity Hub location.
- `--verbose` Enable verbose logging.
- `--json` Prints the last line of output as JSON string.

Installs the latest Unity 6 version with Android and iOS modules:

```bash
unity-cli setup-unity --unity-version 6000 --modules android,ios
```

#### Uninstall Unity Editor

`uninstall-unity [options]`: Uninstall a Unity Editor version.

- `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
- `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
- `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
- `--verbose` Enable verbose logging.

```bash
unity-cli uninstall-unity --unity-version 6000
```

### Unity Editor

#### Run Unity Editor Commands

`run [options] <args...>`: Run Unity Editor command line arguments (passes args directly to the editor).

- `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `--unity-project` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable will be used, otherwise no project will be specified.
- `--log-name <logName>` The name of the log file.
- `--log-level <logLevel>` Override the logger verbosity (`debug`, `info`, `minimal`, `warning`, `error`). Defaults to `info`.
- `--verbose` Enable verbose logging. (Deprecated, use `--log-level <value>` instead)
- `<args...>` Arguments to pass directly to the Unity Editor executable.

> [!NOTE]
> When setting the `--log-level` option to `minimal`, only the unity telemetry logs will be shown in the console output. All other logs will be written to the log file. This option is only supported when running the command locally in the terminal. ***This options is still experimental and may change in future releases.***
>
> When running in CI environments the logger will automatically print the full logs to the console no matter the log level.

```bash
unity-cli run --unity-project <path-to-project> -quit -batchmode -executeMethod StartCommandLineBuild
```

#### List Project Templates

> [!NOTE]
> Regex patterns are supported for the `--template` option. For example, to create a 3D project with either the standard or cross-platform template, you can use `com.unity.template.3d(-cross-platform)?`.

`list-project-templates [options]`: List available Unity project templates for an editor.

- `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
- `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
- `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
- `--verbose` Enable verbose logging.
- `--json` Prints the last line of output as JSON string.

Lists available project templates for Unity 6:

```bash
unity-cli list-project-templates --unity-version 6000
```

#### Create Unity Project

`create-project [options]`: Create a new Unity project from a template.

- `-n`, `--name <projectName>` The name of the new Unity project. If unspecified, the project will be created in the specified path or the current working directory.
- `-p`, `--path <projectPath>` The path to create the new Unity project. If unspecified, the current working directory will be used.
- `-t`, `--template <projectTemplate>` The name of the template package to use for creating the unity project. Supports regex patterns. (default:
 `com.unity.template.3d(-cross-platform)?`)
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
- `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version`, or the `UNITY_EDITOR_PATH` environment variable must be set.
- `--verbose` Enable verbose logging.
- `--json` Prints the last line of output as JSON string.

Creates a new Unity project named "MyGame" using the latest version of Unity 6 and the 3D template:

```bash
unity-cli create-project --name "MyGame" --template com.unity.template.3d(-cross-platform)? --unity-version 6000
```

#### Open Unity Project

`open-project [options]`: Open a Unity project in the Unity Editor.

- `-p`, `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable or the current working directory will be used.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If specified, it will override the version read from the project.
- `-t`, `--build-target <buildTarget>` The Unity build target to switch the project to (e.g. `StandaloneWindows64`, `StandaloneOSX`, `iOS`, `Android`, etc).
- `--verbose` Enable verbose logging.

Opens a specific Unity project with the latest Unity 6 version and switches the active platform to Android:

```bash
unity-cli open-project --unity-project <path-to-project> --unity-version 6000 --build-target Android
```

> [!TIP]
> If you run this command in the same directory as your Unity project, you can omit the `--unity-project`, `--unity-version`, and `--unity-editor` options.

```bash
unity-cli open-project
```

#### Unity Editor Logs

`editor-logs`: Prints the path to the Unity Editor log files.

```bash
unity-cli editor-logs
```

### Unity Package Manager

#### Install Unity Package Manager

`upm-install [options]`: Download and install the Unity Package Manager cli (pack/sign) under `~/.unity-cli/upm`.

- `--auto-update`: Automatically updates the upm cli if it is already installed and a newer release is available. Cannot be used with `--version`.
- `--version <version>`: Install a specific upm cli release tag (for example `v9.27.0`). Defaults to the latest release from the Unity CDN.
- `--json`: Print version and managed paths as JSON.
- `--verbose`: Enable verbose output.

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
- `--destination <path>`: The output path where UPM CLI places the signed tarball. If you specify a folder that doesn’t exist, UPM CLI creates it. Note: If you omit this parameter, UPM CLI places the file in the current working directory.
- `--verbose`: Enable verbose output.

> [!NOTE]
> Set `UNITY_ORGANIZATION_ID` or `UNITY_ORG_ID`, `UPM_SERVICE_ACCOUNT_KEY_ID`, and `UPM_SERVICE_ACCOUNT_KEY_SECRET`, or leave them unset in an interactive terminal to be prompted securely.

```bash
unity-cli upm-pack --source <path-to-package-folder> --destination <output-path>
```

#### Deprecated Sign Package Command

> [!WARNING]
> **Deprecated:** `sign-package` is deprecated and may be removed in a future release. Use `unity-cli upm-pack --source <path-to-package-folder> --destination <output-path>` with organization and service account credentials from environment variables (or secure prompts), as for `upm-pack` above.

`sign-package [options]`: Sign a Unity package using Unity Editor 6000.3+ batch mode (`-upmPack`).

- `--package <package>` Required. The fully qualified path to the folder that contains the package.json file for the package you want to sign. Note: Don't include package.json in this parameter value.
- `--output <output>` Optional. The output directory where you want to save the signed tarball file (.tgz). If unspecified, the package contents will be updated in place with the signed .attestation.p7m file.
- `--email <email>` Email associated with the Unity account. If unspecified, the `UNITY_USERNAME` environment variable will be used.
- `--password <password>` The password of the Unity account. If unspecified, the `UNITY_PASSWORD` environment variable will be used.
- `--organization <organization>` The Organization ID you copied from the Unity Cloud Dashboard. If unspecified, the `UNITY_ORGANIZATION_ID` environment variable will be used.
- `--verbose` Enable verbose logging.

> [!NOTE]
> The `--output` option is optional. If not specified, the package contents will be updated in place with the signed `.attestation.p7m` file. Otherwise a signed `.tgz` file will be created in the specified output directory.

```bash
unity-cli sign-package --package <path-to-package-folder> --email <your-email> --password <your-password> --organization <your-organization-id>
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
- `CI_mask`, `CI_setEnvironmentVariable`, and `CI_setOutput` write to the corresponding GitHub-provided files when those features are configured.
- **Job summary (`GITHUB_STEP_SUMMARY`) is opt-in:** set `UNITY_CLI_WORKFLOW_SUMMARY` to `1`, `true`, `yes`, or `on` (case-insensitive) so `CI_appendWorkflowSummary` can append the rich markdown block from Unity log / UTP parsing. If unset, summary output is skipped (annotations and stdout behavior are unchanged).

The same command line you run locally therefore produces colorized console output on your machine and rich annotations once it runs inside Actions.

### Additional CI Environments

At the moment, only GitHub Actions is supported for enhanced logging. If you would like to see support for additional CI environments, please open a pull request or feature request on the GitHub repository.

#### Roadmap

- [ ] Support Azure DevOps logging commands
- [ ] Support GitLab CI logging commands
- [ ] Support Bitbucket Pipelines logging commands
- [ ] Support Jenkins logging commands
- [ ] Support CircleCI logging commands
- [ ] Support Travis CI logging commands
- [ ] Support TeamCity logging commands
