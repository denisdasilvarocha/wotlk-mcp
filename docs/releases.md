# Database release operations

Database release tags use `db-v<major>.<minor>.<patch>` and are independent of the package's `v` tags and the client-input bundle. A published database release and its assets are immutable: never overwrite an asset, reuse its tag for different contents, or edit the database in place. A corrected database requires a new version and the full release gates and acceptance matrix again.

## Before the initial publication

Production publication is not authorized merely because a workflow exists or an environment is named. The owner must explicitly authorize initial publication, provision and protect the production authorization mechanism, and approve the independently reviewed World Data facts. A newly auto-created GitHub environment has no protection rules or secrets; it is not owner approval. The verified complete candidate, its uploaded draft asset, every required gate and all six Windows/macOS/Linux by Node 24.15/current acceptance cells must pass before promotion. The fixtures must be the approved, cited fixtures, not sample or builder-derived facts. Until then, no production database release is authorized.

Before enabling publication, the owner must configure the `database-publication` environment with the repository owner as its **sole required reviewer**, disable administrator bypass, restrict deployments to `main`, and set its environment secret `DATABASE_RELEASE_AUTHORIZATION` to `owner-authorized`. Do not set a repository- or organization-level secret with that name. The workflow checks for the secret before building; the release command also reads the GitHub environment API and rejects missing reviewer protection. Referencing an unconfigured environment can create it automatically, but the missing secret and reviewer cause failure. The owner must separately approve each protected candidate and promotion job. These settings are not provisioned by this repository.

Automatic runs respond only to main-branch pins, data, source, pipeline or fixture changes; manual runs may explicitly request the count-shrink override. Runs are serialized and never repin inputs. A failed draft stays undiscoverable and reserves its version. After investigating, an authorized operator may delete that failed **draft** before retrying; never delete or replace an existing published asset to make a retry work. Release tags are never reused.

The complete build uses `vp run build:complete-reference /absolute/path/to/new-directory`; it requires the verified pinned inputs and a fresh MySQL environment. Gate preparation computes and writes the schema version before compression. The commands below show the optional previous-database argument in brackets: replace it with a verified path, or omit it entirely for the first release.

```sh
vpx scripts/release-gate.ts candidate/wotlk.sqlite candidate/wotlk.sqlite.br [previous.sqlite] --prepare
# Recompress candidate/wotlk.sqlite to candidate/wotlk.sqlite.br here.
vpx scripts/release-gate.ts candidate/wotlk.sqlite candidate/wotlk.sqlite.br [previous.sqlite]
```

The optional previous database must be downloaded from the newest published database release and verified against the GitHub asset digest before decompression. Omit it only for the first database release. `--allow-shrink` is an explicit maintainer override for count shrinkage only; it does not waive any other gate. Because preparation changes the database, recompression also changes the asset: replace the builder's pre-preparation compressed size and hash in the published report with the measurements of the final recompressed asset. Acceptance must use the actual uploaded draft asset after verifying its GitHub digest, not a local pre-upload copy. Every release must include the generated `NOTICE.md`, fidelity report, count and size report, and source and rights information.

## Rollback

Rollback changes discoverability, not the bytes of an existing published asset. After the owner authorizes a rollback, identify the exact `db-v…` tag and confirm that a previous compatible published database remains available. Inspect the target and the surrounding releases before choosing one of the following irreversible or externally visible operations:

```sh
gh api "repos/$GITHUB_REPOSITORY/releases/tags/db-vX.Y.Z" --jq '{id,tag_name,draft,prerelease,assets}'
# Set GITHUB_TOKEN and DATABASE_RELEASE_AUTHORIZATION in the operator environment.
# Prefer marking the bad release as a prerelease, preserving it for investigation:
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z prerelease
# Alternatively, after explicit authorization, delete the release:
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z delete
```

Replace the illustrative tag with the independently checked target. Deleting a release does not automatically delete its Git tag; do not delete or reuse that tag as part of rollback. GitHub's [immutable release policy](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) permits prerelease marking and release deletion but protects assets and prevents reuse of immutable tag names. Neither operation immediately changes a running server or invalidates every local cache. Clients discover the newest currently published compatible release on their normal update check, and activate a verified replacement on a later start; offline clients can continue using a cached copy. Communicate the withdrawal and its limitations to users. Do not publish a replacement until it passes all build, approval, artifact and matrix gates.
