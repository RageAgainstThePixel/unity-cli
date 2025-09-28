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

```bash
unity-cli [command] [options]
```

### Common Commands

- `unity-cli hub-install`: Install Unity Hub
- `unity-cli hub-version`: Print Unity Hub version
- `unity-cli hub-path`: Print Unity Hub executable path
- `unity-cli hub [options] <args...>`: Run [Unity Hub command line arguments](https://docs.unity3d.com/hub/manual/HubCLI.html)
- `unity-cli activate-license [options]`: Activate a Unity license
- `unity-cli return-license [options]`: Return a Unity license
- `unity-cli license-version`: Print Unity License Client version
- `unity-cli setup-unity [options]`: Find or install Unity Editor for a project/version
- `unity-cli create-project [options]`: Create a new Unity project from a [template](https://docs.unity3d.com/hub/manual/Templates.html)
- `unity-cli run [options] <args...>`: Run [Unity Editor Command Line Arguments](https://docs.unity3d.com/Manual/EditorCommandLineArguments.html)

#### Install Unity Hub and Editor

```bash
unity-cli hub-install
unity-cli setup-unity --unity-version 2022.3.x --modules android,ios
```

#### Activate a Unity License

```bash
unity-cli activate-license --email <your-email> --password <your-password> --serial <your-serial>
```

#### Create a New Project from a Template

```bash
unity-cli create-project --name "MyGame" --template com.unity.template.3d --unity-editor <path-to-editor>
```

#### Build a Project

```bash
unity-cli run --unity-editor <path-to-editor> --unity-project <path-to-project> -quit -batchmode -executeMethod StartCommandLineBuild
```
