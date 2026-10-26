# Unity version support

This repo tests Unity editors on CI in two tiers:

| Tier | What it means | How CI selects |
|------|----------------|----------------|
| **Tested** | Integration matrix, from 4.7.2 through the newest Unity 6 beta and the Unity 7 alpha | [`.github/workflows/build-options.json`](../.github/workflows/build-options.json) via `setup-unity --channel f,b,a`: each row runs the newest build of its stream, and a final release wins once the stream has one |
| **Untested** | Not in CI; still installable | Fully-qualified `-u 6000.x.yfN -c <changeset>` or partial + `--channel b\|a` |

## Resolving versions

- Partial versions (`6000.5`, `2021.3.x`) resolve only within the requested channel(s). Default is **stable (`f`)**.
- If no matching stable release exists (e.g. `6000.7` while only betas ship), `setup-unity` **fails closed** instead of letting the installer guess a beta.
- Use `--channel b` (or `a`) when you intentionally want pre-release streams.
- Weekly [unity-release-discovery](../.github/workflows/unity-release-discovery.yml) compares the Releases API to the matrix and opens/updates a `unity-release-drift` issue when a stream is missing from it.

## Dependencies

Integration UTP batches install `com.utilities.buildpipeline` from OpenUPM **unpinned** (latest), so the beta and alpha rows also exercise Validate + TMP essentials import against that package.
