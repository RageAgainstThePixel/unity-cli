# unity-cli

[![Discord](https://img.shields.io/discord/855294214065487932.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/xQgMW9ufN4) [![NPM Version](https://img.shields.io/npm/v/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli) [![NPM Downloads](https://img.shields.io/npm/dw/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli)

A powerful command line utility for the Unity Game Engine. Automate Unity project setup, editor installation, license management, building, and more—ideal for CI/CD pipelines and developer workflows.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Common Commands](#common-commands)
    - [Auth](#auth)
      - [License Version](#license-version)
      - [Activate License](#activate-license)
      - [Return License](#return-license)
    - [Unity Hub](#unity-hub)
      - [Hub Version](#hub-version)
      - [Hub Path](#hub-path)
      - [Unity Hub Install](#unity-hub-install)
      - [Run Unity Hub Commands](#run-unity-hub-commands)
    - [Unity Editor](#unity-editor)
      - [Setup Unity Editor](#setup-unity-editor)
      - [Uninstall Unity Editor](#uninstall-unity-editor)
      - [List Project Templates](#list-project-templates)
      - [Create Unity Project](#create-unity-project)
      - [Open Unity Project](#open-unity-project)
      - [Run Unity Editor Commands](#run-unity-editor-commands)
    - [Unity Package Manager](#unity-package-manager)
      - [Sign a Unity Package](#sign-a-unity-package)
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

#### Auth

##### License Version

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
- `-c`, `--config`: Path to the configuration file, or base64 encoded JSON string. Required when activating a floating license.
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

Prints the current license context information.

```bash
unity-cli license-context
```

#### Licensing Logs

Prints the Unity licensing logs.

```bash
unity-cli license-logs
```

#### Unity Hub

##### Hub Version

`hub-version`: Print the Unity Hub version.

```bash
unity-cli hub-version
```

##### Hub Path

`hub-path`: Print the Unity Hub executable path.

```bash
unity-cli hub-path
```

##### Unity Hub Install

`hub-install [options]`: Install or update the Unity Hub

- `--auto-update`: Automatically updates the Unity Hub if it is already installed. Cannot be used with `--hub-version`.
- `--hub-version`: Specify to install a specific version of Unity Hub. Cannot be used with `--auto-update`.
- `--verbose`: Enable verbose output.
- `--json`: Output installation information in JSON format.

```bash
unity-cli hub-install
```

##### Run Unity Hub Commands

`hub [options] <args...>`: Run Unity Hub command line arguments (passes args directly to the hub executable).

- `--verbose`: Enable verbose output.
- `<args...>`: Arguments to pass directly to the Unity Hub executable.

Lists available Unity Hub commands:

```bash
unity-cli --verbose hub help
```

Gets a list of installed editors:

```bash
unity-cli hub editors --installed
```

#### Unity Editor

##### Setup Unity Editor

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

##### Uninstall Unity Editor

`uninstall-unity [options]`: Uninstall a Unity Editor version.

- `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
- `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
- `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
- `--verbose` Enable verbose logging.

```bash
unity-cli uninstall-unity --unity-version 6000
```

##### List Project Templates

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

##### Create Unity Project

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

##### Open Unity Project

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

##### Run Unity Editor Commands

`run [options] <args...>`: Run Unity Editor command line arguments (passes args directly to the editor).

- `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `--unity-project` or the `UNITY_EDITOR_PATH` environment variable must be set.
- `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable will be used, otherwise no project will be specified.
- `--log-name <logName>` The name of the log file.
- `--log-level <logLevel>` Override the logger verbosity (`debug`, `info`, `minimal`, `warning`, `error`).
- `--verbose` Enable verbose logging. (Deprecated, use `--log-level <value>` instead)
- `<args...>` Arguments to pass directly to the Unity Editor executable.

> [!NOTE]
> When setting the `--log-level` option to `minimal`, only the unity telemetry logs will be shown in the console output. All other logs will be written to the log file. This option is only supported when running the command locally in the terminal.
>
> When running in CI environments the logger will automatically print the full logs to the console no matter the log level.

```bash
unity-cli run --unity-project <path-to-project> -quit -batchmode -executeMethod StartCommandLineBuild
```

#### Unity Package Manager

##### Sign a Unity Package

> [!WARNING]
> This command feature is in beta and may change in future releases.

`sign-package [options]`: Sign a Unity package for distribution.

- `--package <package>` Required. The fully qualified path to the folder that contains the package.json file for the package you want to sign. Note: Don’t include package.json in this parameter value.
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
- Helper methods (`CI_mask`, `CI_setEnvironmentVariable`, `CI_setOutput`, `CI_appendWorkflowSummary`) write to the corresponding GitHub-provided files, so secrets stay masked and workflow outputs update automatically.

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
