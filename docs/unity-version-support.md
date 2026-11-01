# Unity version support

This repo tests Unity editors on CI in three tiers:

| Tier | What it means | How CI selects |
|------|----------------|----------------|
| **Tested on every PR** | The streams the official CLI lists with `unity editors --releases`: the LTS lines, the current release, the beta and the alpha | The setup job of integration-tests reads that list at run time and runs each stream with the platform rows in [`.github/workflows/build-options.json`](../.github/workflows/build-options.json), whose own list is the fallback. `setup-unity --channel f,b,a` runs the newest build of each stream, and a final release wins once the stream has one |
| **Tested monthly** | The newest release of every major.minor line: 4.7.2 through 2022.3, and every 6000.x and 7000.x line | [`.github/workflows/build-options-legacy.json`](../.github/workflows/build-options-legacy.json), on the monthly schedule or a manual run of integration-tests with `editors: legacy`. When a new series ships, add its major.minor to that list |
| **Untested** | Not in CI; still installable | Fully-qualified `-u 6000.x.yfN -c <changeset>` or partial + `--channel b\|a` |

## Resolving versions

- Partial versions (`6000.5`, `2021.3.x`) resolve only within the requested channel(s). Default is **stable (`f`)**.
- If no matching stable release exists (e.g. `6000.7` while only betas ship), `setup-unity` **fails closed** instead of letting the installer guess a beta.
- Use `--channel b` (or `a`) when you intentionally want pre-release streams.
- Releases Unity labels with a Security Alert stop `setup-unity` unless `--allow-security-alert` or `UNITY_ALLOW_SECURITY_ALERT=1` is given. The error names the newest unlabelled stable release on the same branch. 4.x and 5.x always need the opt-in, since Unity never patched them. The monthly matrix opts in, so its 4.7.2 through 2018 rows run; the pull request matrix does not. See [Setup Unity Editor](../README.md#setup-unity-editor).

## Dependencies

Integration UTP batches install `com.utilities.buildpipeline` from OpenUPM **unpinned** (latest), so the beta and alpha rows also exercise Validate + TMP essentials import against that package.
