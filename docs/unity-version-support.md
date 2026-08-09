# Unity version support

This repo tests Unity editors on CI in three tiers:

| Tier | What it means | How CI selects |
|------|----------------|----------------|
| **Supported** | Blocking integration matrix; must stay green for releases | [`.github/workflows/build-options.json`](../.github/workflows/build-options.json) via `setup-unity` with default `--channel f` (stable/`f` only) |
| **Preview** | Best-effort beta canary; may be red (e.g. package TMP import) | [`.github/workflows/unity-preview-canary.yml`](../.github/workflows/unity-preview-canary.yml) — pinned FQ beta + `--channel b`, `continue-on-error` |
| **Untested** | Not in CI; still installable | Fully-qualified `-u 6000.x.yfN -c <changeset>` or partial + `--channel b\|a` |

## Resolving versions

- Partial versions (`6000.5`, `2021.3.x`) resolve only within the requested channel(s). Default is **stable (`f`)**.
- If no matching stable release exists (e.g. `6000.6` while only betas ship), `setup-unity` **fails closed** instead of letting Hub guess a beta.
- Use `--channel b` (or `a`) when you intentionally want pre-release streams.
- Weekly [unity-release-discovery](../.github/workflows/unity-release-discovery.yml) compares the Releases API to the matrix/canary pin and opens/updates a `unity-release-drift` issue when tips move.

## Dependencies

Integration UTP batches install `com.utilities.buildpipeline` from OpenUPM **unpinned** (latest). Preview canary exercises Validate + TMP essentials import against that package.
