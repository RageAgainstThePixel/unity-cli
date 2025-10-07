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

#### Auth

- `unity-cli license-version`: Print the Unity License Client version
- `unity-cli activate-license [options]`: Activate a Unity license
- `unity-cli return-license [options]`: Return a Unity license

#### Unity Hub

- `unity-cli hub-version`: Print the Unity Hub version
- `unity-cli hub-install [options]`: Install or update the Unity Hub
- `unity-cli hub-path`: Print the Unity Hub executable path
- `unity-cli hub [options] <args...>`: Run Unity Hub command line arguments (passes args directly to the hub executable)

#### Unity Editor

- `unity-cli setup-unity [options]`: Find or install the Unity Editor for a project or specific version
- `unity-cli uninstall-unity [options]`: Uninstall a Unity Editor version
- `unity-cli list-project-templates [options]`: List available Unity project templates for an editor
- `unity-cli create-project [options]`: Create a new Unity project from a template
- `unity-cli open-project [options]`: Open a Unity project in the Unity Editor
- `unity-cli run [options] <args...>`: Run Unity Editor command line arguments (passes args directly to the editor)

Run `unity-cli --help` for a full list of commands and options.

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
