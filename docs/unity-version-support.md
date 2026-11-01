# Unity version support

This repo tests Unity editors on CI in three tiers:

| Tier | What it means | How CI selects |
|------|----------------|----------------|
| **Tested on every PR** | Unity 6000.0 through the newest Unity 6 beta and the Unity 7 alpha | [`.github/workflows/build-options.json`](../.github/workflows/build-options.json) via `setup-unity --channel f,b,a`: each row runs the newest build of its stream, and a final release wins once the stream has one |
| **Tested monthly** | 4.7.2 through 2022.3, which no longer change | [`.github/workflows/build-options-legacy.json`](../.github/workflows/build-options-legacy.json), on the monthly schedule or a manual run of integration-tests with `editors: legacy` |
| **Untested** | Not in CI; still installable | Fully-qualified `-u 6000.x.yfN -c <changeset>` or partial + `--channel b\|a` |

## Resolving versions

- Partial versions (`6000.5`, `2021.3.x`) resolve only within the requested channel(s). Default is **stable (`f`)**.
- If no matching stable release exists (e.g. `6000.7` while only betas ship), `setup-unity` **fails closed** instead of letting the installer guess a beta.
- Use `--channel b` (or `a`) when you intentionally want pre-release streams.
- Releases Unity labels with a Security Alert stop `setup-unity` unless `--allow-security-alert` or `UNITY_ALLOW_SECURITY_ALERT=1` is given. The error names the newest unlabelled stable release on the same branch. 4.x and 5.x always need the opt-in, since Unity never patched them. The legacy matrix opts in, so its 4.7.2 through 2018 rows run; the Unity 6 and newer rows do not. See [Setup Unity Editor](../README.md#setup-unity-editor).
- Weekly [unity-release-discovery](../.github/workflows/unity-release-discovery.yml) compares the Releases API to the matrix, writes the report to the run summary, and warns on the run when a stream is missing from it.

## Dependencies

Integration UTP batches install `com.utilities.buildpipeline` from OpenUPM **unpinned** (latest), so the beta and alpha rows also exercise Validate + TMP essentials import against that package.
