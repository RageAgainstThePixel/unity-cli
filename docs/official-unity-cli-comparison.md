# unity-cli and the official Unity CLI

unity-cli is not a replacement for Unity's official CLI (`unity`). Since v4 it installs and wraps the official CLI, and only fills the gaps the official CLI leaves, mostly for older Unity releases that people still need to open, build and test for archival purposes.

If the official CLI does what you need, use it directly. See [Use the Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli).

## Why unity-cli still exists

- **Older editors.** Projects shipped on Unity 4.x, 5.x and 2017-2022 still need to be opened, rebuilt and tested years later. The official CLI targets current releases, and it cannot install 4.x or 5.x at all.
- **CI runners.** unity-cli handles the parts of a headless CI job the official CLI leaves to you: installing the CLI itself, Linux system packages, licensing on runners that share a machine identity, and turning Editor logs into CI annotations.
- **Maintenance mode.** v4 is the last feature release. New features go to Unity. unity-cli only gets security and crash fixes.

## At a glance

| Area | Official Unity CLI | unity-cli v4 |
| --- | --- | --- |
| Install the CLI itself | Install script, then manual updates | Downloads a pinned or latest release on first use, verifies its SHA-256, caches it in the runner tool cache and puts it on `PATH` |
| Editor installs, 2017.4 and newer | `unity install` | Calls `unity install` (resume, terms acceptance, modules) |
| Editor installs, 5.x | Not supported (one-digit majors read as Unity 6 shorthand) | Installs from Unity's download archive, Windows and macOS |
| Editor installs, 4.x | Not supported (not listed by any release service) | Installs from Unity's legacy installers, Windows and macOS |
| Partial versions (`2021.3.x`, `6000`) | Exact versions | Resolves to the newest release in the requested channels, fails closed instead of picking a beta |
| Modules from a project | Manual | Reads `ProjectVersion.txt` and Unity 6 build profiles to pick the version and modules |
| Linux editor dependencies | Not handled | Installs system packages, the older libssl that 2019.1-2021.x link against, and the Bee backend workaround |
| Android target SDK | Not handled | Installs the project's target SDK with the editor's bundled tools |
| Run the editor | `unity run` | Calls `unity run` for 2019.1 and newer projects. Launches the editor directly for older editors, runs without a project, Linux runs that need `xvfb`, and x86_64 editors under Rosetta |
| Editor logs in CI | Raw log | Live log, with GitHub Actions annotations, log groups and an optional job summary from the Editor log and Unity Test Protocol output |
| Process cleanup | Not handled | Stops only the processes this run started, so shared self-hosted runners are safe |
| Builds and tests | `unity build`, `unity test` | Not wrapped. Use the official commands, or `unity-cli run` with your own arguments |
| Project create, open, templates | `unity projects create`, `unity open`, `unity templates list` | v3 commands kept as deprecated forwards to these |
| Uninstall | `unity uninstall` | v3 `uninstall-unity` kept as a deprecated forward |
| Sign in | Browser or service account | Uses the official CLI first |
| Serial, floating, offline licenses | `unity license activate` | Uses the official CLI first |
| Personal license on a headless runner | Needs a browser sign-in | Falls back to the Unity Licensing Client with a Unity ID email and password |
| Licenses for 4.x and 5.x editors | Not supported (licenses are written as 6.x) | Patches a copy of the licensing client so it writes a license those editors read |
| License return on shared runners | `unity license return` | `--when auto` skips personal returns on GitHub-hosted macOS and Linux, which share one machine identity across jobs and repos, so one return does not revoke everyone's license |
| Unity Package Manager pack and sign | Separate `upm` CLI | Installs the `upm` CLI and packs signed packages with it |
| Pass-through of unknown commands | n/a | None. Call `unity` directly |

## Unity version coverage

| Unity version | Install | License | Run |
| --- | --- | --- | --- |
| Unity 6 and newer | Official CLI | Official CLI, then licensing client fallback | Official CLI |
| 2019.1-2022.3 | Official CLI | Official CLI, then licensing client fallback | Official CLI |
| 2017.4-2018.4 | Official CLI | Official CLI, then licensing client fallback | Direct launch |
| 5.x | unity-cli, from the download archive (Windows, macOS) | Patched licensing client | Direct launch |
| 4.x | unity-cli, from legacy installers (Windows, macOS) | Patched licensing client | Direct launch |

The streams `unity editors --releases` lists are tested on every pull request. The newest release of every major.minor line, 4.7.2 onward, is tested monthly. See [Unity version support](unity-version-support.md).

## When to use which

- Use the official CLI for anything it covers on current releases: installs, builds, tests, sign-in and license activation.
- Use unity-cli when you need 4.x or 5.x editors, a personal license on a headless runner, Linux and Android setup in CI, or Editor log annotations in GitHub Actions.
- Send feature requests the official CLI already covers to Unity.

unity-cli is an independent project, not affiliated with Unity Technologies. Unity, Unity Hub and Unity Editor are trademarks of Unity Technologies.
