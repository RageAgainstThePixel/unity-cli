# unity-cli

[![Discord](https://img.shields.io/discord/855294214065487932.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/xQgMW9ufN4) [![NPM Version](https://img.shields.io/npm/v/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli) [![NPM Downloads](https://img.shields.io/npm/dw/%40rage-against-the-pixel%2Funity-cli)](https://www.npmjs.com/package/@rage-against-the-pixel/unity-cli)

A powerful command line utility for the Unity Game Engine. Automate Unity project setup, editor installation, license management, building, and more—ideal for CI/CD pipelines and developer workflows.

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
unity-cli [command] [options] <args...>
```

With options always using double dashes (`--option`) and arguments passed directly to Unity or Unity Hub commands as they normally would with single dashes (`-arg`). Each option typically has a short alias using a single dash (`-o`), except for commands where we pass through arguments, as those get confused by the command parser.

### Common Commands

- `unity-cli --help` for a full list of commands and options.
- `unity-cli [command] --help` for details on a specific command.
- `unity-cli [command] --json` to get the output in JSON format (if supported).
- `unity-cli [command] --verbose` to enable verbose logging for debugging.

#### Auth

- `unity-cli license-version`: Print the Unity License Client version.
- `unity-cli activate-license [options]`: Activate a Unity license.
  - `-l`, `--license`: License type (personal, professional, floating). Required.
  - `-e`, `--email`: Email associated with the Unity account. Required when activating a personal or professional license.
  - `-p`, `--password`: Password for the Unity account. Required when activating a personal or professional license.
  - `-s`, `--serial`: License serial number. Required when activating a professional license.
  - `-c`, `--config`: Path to the configuration file, or base64 encoded JSON string. Required when activating a floating license.
  - `--verbose`: Enable verbose output.
- `unity-cli return-license [options]`: Return a Unity license.
  - `-l`, `--license`: License type (personal, professional, floating)
  - `--verbose`: Enable verbose output.

#### Unity Hub

- `unity-cli hub-version`: Print the Unity Hub version.
- `unity-cli hub-path`: Print the Unity Hub executable path.
- `unity-cli hub-install [options]`: Install or update the Unity Hub
  - `--auto-update`: Automatically updates the Unity Hub if it is already installed. Cannot be used with --hub-version.
  - `--hub-version`: Specify to install a specific version of Unity Hub. Cannot be used with --auto-update.
  - `--verbose`: Enable verbose output.
  - `--json`: Output installation information in JSON format.
- `unity-cli hub [options] <args...>`: Run Unity Hub command line arguments (passes args directly to the hub executable).
  - `<args...>`: Arguments to pass directly to the Unity Hub executable.
  - `--verbose`: Enable verbose output.

#### Unity Editor

- `unity-cli setup-unity [options]`: Find or install the Unity Editor for a project or specific version.
  - `-p`, `--unity-project <unityProject>` The path to a Unity project or `none` to skip project detection.
  - `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If specified, it will override the version read from the project.
  - `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
  - `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
  - `-b`, `--build-targets <buildTargets>` The Unity build target to get (e.g. `iOS,Android`).
  - `-m`, `--modules <modules>` The Unity module to get (e.g. ios, android).
  - `-i`, `--install-path <installPath>` The path to install the Unity Editor to. By default, it will be installed to the default Unity Hub location.
  - `--verbose` Enable verbose logging.
  - `--json` Prints the last line of output as JSON string.
- `unity-cli uninstall-unity [options]`: Uninstall a Unity Editor version.
  - `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version` or the `UNITY_EDITOR_PATH` environment variable must be set.
  - `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
  - `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
  - `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
  - `--verbose` Enable verbose logging.
- `unity-cli list-project-templates [options]`: List available Unity project templates for an editor.
  - `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version` or the `UNITY_EDITOR_PATH` environment variable must be set.
  - `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
  - `-c`, `--changeset <changeset>` The Unity changeset to get (e.g. `1234567890ab`).
  - `-a`, `--arch <arch>` The Unity architecture to get (e.g. `x86_64`, `arm64`). Defaults to the architecture of the current process.
  - `--verbose` Enable verbose logging.
  - `--json` Prints the last line of output as JSON string.
- `unity-cli create-project [options]`: Create a new Unity project from a template.
  - `-n`, `--name <projectName>` The name of the new Unity project. If unspecified, the project will be created in the specified path or the current working directory.
  - `-p`, `--path <projectPath>` The path to create the new Unity project. If unspecified, the current working directory will be used.
  - `-t`, `--template <projectTemplate>` The name of the template package to use for creating the unity project. Supports regex patterns. (default:
 `com.unity.template.3d(-cross-platform)?`)
  - `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If unspecified, then `--unity-editor` must be specified.
  - `-e`, `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `-u`, `--unity-version`, or the `UNITY_EDITOR_PATH` environment variable must be set.
  - `--verbose` Enable verbose logging.
  - `--json` Prints the last line of output as JSON string.
- `unity-cli open-project [options]`: Open a Unity project in the Unity Editor.
  - `-p`, `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable or the current working directory will be used.
  - `-u`, `--unity-version <unityVersion>` The Unity version to get (e.g. `2020.3.1f1`, `2021.x`, `2022.1.*`, `6000`). If specified, it will override the version read from the project.
  - `-t`, `--build-target <buildTarget>` The Unity build target to switch the project to (e.g. `StandaloneWindows64`, `StandaloneOSX`, `iOS`, `Android`, etc).
  - `--verbose` Enable verbose logging.
- `unity-cli run [options] <args...>`: Run Unity Editor command line arguments (passes args directly to the editor).
  - `--unity-editor <unityEditor>` The path to the Unity Editor executable. If unspecified, `--unity-project` or the `UNITY_EDITOR_PATH` environment variable must be set.
  - `--unity-project <unityProject>` The path to a Unity project. If unspecified, the `UNITY_PROJECT_PATH` environment variable will be used, otherwise no project will be specified.
  - `--log-name <logName>` The name of the log file.
    - `<args...>` Arguments to pass directly to the Unity Editor executable.
  - `--verbose` Enable verbose logging.

#### Unity Package Manager

> [!WARNING]
> This command feature is in beta and may change in future releases.

- `unity-cli sign-package [options]`: Sign a Unity package for distribution.
  - `--package <package>` Required. The fully qualified path to the folder that contains the package.json file for the package you want to sign. Note: Don’t include package.json in this parameter value.
  - `--output <output>` Optional. The output directory where you want to save the signed tarball file (.tgz). If unspecified, the package contents will be updated in place with the signed .attestation.p7m file.
  - `--email <email>` Email associated with the Unity account. If unspecified, the `UNITY_USERNAME` environment variable will be used.
  - `--password <password>` The password of the Unity account. If unspecified, the `UNITY_PASSWORD` environment variable will be used.
  - `--organization <organization>` The Organization ID you copied from the Unity Cloud Dashboard. If unspecified, the `UNITY_ORGANIZATION_ID` environment variable will be used.
  - `--verbose` Enable verbose logging.

#### Install Unity Hub and Editor

```bash
unity-cli hub-install
unity-cli setup-unity --unity-version 2022.3.x --modules android,ios
```

#### Activate a Unity License

Supports personal, professional, and floating licenses (using a license server configuration).

```bash
unity-cli activate-license --license personal --email <your-email> --password <your-password>
```

#### Create a New Project from a Template

> [!NOTE]
> Regex patterns are supported for the `--template` option. For example, to create a 3D project with either the standard or cross-platform template, you can use `com.unity.template.3d(-cross-platform)?`.

```bash
unity-cli create-project --name "MyGame" --template com.unity.template.3d(-cross-platform)? --unity-editor <path-to-editor>
```

#### Open a project from the command line

> [!TIP]
> If you run this command in the same directory as your Unity project, you can omit the `--unity-project`, `--unity-version`, and `--unity-editor` options.

```bash
unity-cli open-project
```

#### Build a Project

```bash
unity-cli run --unity-project <path-to-project> -quit -batchmode -executeMethod StartCommandLineBuild
```

#### Sign a Unity Package

> [!NOTE]
> The `--output` option is optional. If not specified, the package contents will be updated in place with the signed `.attestation.p7m` file. Otherwise a signed `.tgz` file will be created in the specified output directory.

```bash
unity-cli sign-package --package <path-to-package-folder> --email <your-email> --password <your-password> --organization <your-organization-id>
```
