# Release operations

## Current authorization status

Production publication is not authorized merely because a workflow exists or an environment is named. The owner must explicitly authorize initial publication, provision and protect the production authorization mechanism, and approve independently reviewed World Data facts. Approval remains deferred. A newly auto-created GitHub environment has no protection rules or secrets; it is not owner approval. The verified complete candidate, its uploaded draft asset, every required gate and all six Windows/macOS/Linux by Node 24.15/current acceptance cells must pass before promotion. Fixtures must be approved and cited, not sample or builder-derived facts.

Before enabling publication, the owner must configure the `database-publication` environment with the repository owner as its **sole required reviewer**, disable administrator bypass, restrict deployments to `main`, and set its environment secret `DATABASE_RELEASE_AUTHORIZATION` to `owner-authorized`. Do not set a repository- or organization-level secret with that name. The workflow checks for the secret before building; the release command also reads the GitHub environment API and rejects missing reviewer protection. The owner must separately approve each protected candidate and promotion job. These settings are not provisioned by this repository.

## Database releases

Database tags use `db-v<major>.<minor>.<patch>`, independent of package `v` tags and the client-input bundle. Published releases and assets are immutable: never overwrite an asset, reuse its tag for different contents, or edit the database in place. A correction requires a new version and the full gates and acceptance matrix again.

Automatic runs respond to relevant main-branch data, source, pipeline or fixture changes; manual runs may explicitly request the count-shrink override. Runs are serialized. Each build resolves current upstream sources as described in the [build guide](build.md#latest-source-selection-and-integrity). A failed draft stays undiscoverable and reserves its version. After investigation an authorized operator may delete that failed **draft** before retrying; never delete or replace a published asset to make a retry work. Release tags are never reused.

Build a candidate into a fresh directory using `vp run build ./candidate`. Gate preparation assigns the schema version before recompression. For the following release commands, set `GITHUB_REPOSITORY` to `denisdasilvarocha/wotlk-mcp` and `GITHUB_TOKEN` to an appropriately authorized GitHub token before running them. Download the published comparison baseline and collect reserved versions:

```sh
node scripts/database-release.mjs previous previous.sqlite versions.json
```

When a previous published database exists, prepare with its downloaded path:

```sh
vpx scripts/prepare-reference.ts candidate previous.sqlite --used-versions=versions.json
```

Only when no published database remains, omit the previous database:

```sh
vpx scripts/prepare-reference.ts candidate --used-versions=versions.json
```

The previous database must be the newest published database release, verified against its GitHub asset digest before decompression. The versions file includes every database release, including drafts and prereleases, and retained Git tags. The gate preserves the schema major required by comparison, then allocates above every reserved version in that major; publication independently refreshes and checks the same inputs. A rollback keeps the surviving published database as baseline without reusing the withdrawn version. `--allow-shrink` is an explicit maintainer override for count shrinkage only; it waives no other gate. Preparation writes the version, recompresses and validates the final asset, and updates `build-report.json` and `gate.json`. Use these final artifacts for publication. Every release includes generated `NOTICE.md`, fidelity report, count and size report, and source and rights information.

## Independent acceptance

The acceptance command runs the actual packed executable against a candidate SQLite database:

```sh
vpx scripts/acceptance.ts /path/to/wotlk-mcp.tgz /path/to/candidate.sqlite tests/fixtures/acceptance.json
```

The cited fixtures include **unapproved** World Data candidates. The command fails until a maintainer reviews the exact assertions in [World Data facts](world-data-facts.md) and records approval in `data/world-acceptance-approval.json`: `status` must be `approved`, with `reviewer`, ISO `date`, a durable review URL `record`, `fixtures_sha256` for the exact fixture file, and `world_cases` listing every approved World case ID. Any fixture change requires a new approval digest. This command does not publish. A local candidate is not a substitute for the actual uploaded draft asset, verified against its GitHub digest, and the six-cell release matrix.

## npm package releases

Package releases are independent of database releases. Set the package version explicitly in `package.json` and tag the same commit `v<version>`. The tag starts `.github/workflows/package-release.yml`. Its guard requires a published, non-prerelease database of the accepted schema major, downloads and verifies its GitHub SHA-256 digest, and checks schema metadata before publishing. It also rejects an already published package version and a schema-major change within an existing package major. Keep old immutable database releases available for older package majors; data-only updates do not require npm releases.

`src/schema.ts` hard-codes the accepted schema major and `wotlkSchemaMajor` in package metadata records it for future release comparisons. Update both together. A schema-major change or breaking tool-contract change requires a new package major; review tool-contract changes explicitly before tagging. Publish the compatible database first. Never delete old database releases as part of a package release.

For #52, the owner must first ensure the unscoped `wotlk-mcp` package exists and is under their control: npm's [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires an existing package. If necessary, npm documents that staging a new package creates a public placeholder; this bootstrap is a separate owner authorization, not performed by this workflow. In npm package settings configure GitHub Actions trusted publishing with organization/user `denisdasilvarocha`, repository `wotlk-mcp`, workflow filename `package-release.yml`, no environment, and **Allow npm publish**. Do not grant dist-tag management. Configure it only when ready: npm expires an unused new trust configuration after two days. The repository and package must be public for automatic provenance. The GitHub-hosted workflow uses npm CLI 11.5.1 or newer, `id-token: write`, and no stored npm token. The owner should restrict token publishing after OIDC works. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

If npm publication succeeds but GitHub release creation fails, the package version cannot be published again; inspect the failed job and create the missing GitHub release for the existing tag rather than retrying publication.

## Historical client-input release

The separately authorized private release is `client-inputs-12340-engb-1`, asset `client-inputs-12340-engb-1.tar.gz`, SHA-256 `9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136`. It contains Blizzard-derived material and the native registration dump, not the executable; owner-accepted redistribution risk is not permission or MIT licensing. The enGB input is an English stand-in, not proven enUS-identical. See [historical provenance](build.md#historical-client-input-provenance).

The one-time publication is complete. By project policy never replace its asset or reuse its tag; changed bytes require a new identity. GitHub's repository-wide immutable releases setting is not enabled, so GitHub does not enforce this policy. This release does not authorize a database or npm release.

## Rollback

Rollback changes discoverability, not existing published bytes. After owner authorization, identify the exact `db-v…` tag and confirm a previous compatible published database remains available. Set `GITHUB_REPOSITORY` to `denisdasilvarocha/wotlk-mcp`, `GITHUB_TOKEN` to an appropriately authorized token, and `DATABASE_RELEASE_AUTHORIZATION` to `owner-authorized` in the operator environment before the commands. Inspect the target and surrounding releases before choosing an externally visible operation:

```sh
gh api "repos/$GITHUB_REPOSITORY/releases/tags/db-vX.Y.Z" --jq '{id,tag_name,draft,prerelease,assets}'
# Prefer marking the bad release as a prerelease, preserving it for investigation:
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z prerelease
# Alternatively, after explicit authorization, delete the release:
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z delete
```

Replace the illustrative tag and ID with the independently checked target. Deleting a release does not automatically delete its Git tag; do not delete or reuse that tag as part of rollback. GitHub's [immutable release policy](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) permits prerelease marking and release deletion but protects assets and prevents reuse of immutable tag names. Neither operation immediately changes a running server or invalidates every cache. Clients discover the newest currently published compatible release on their normal update check and activate a verified replacement on a later start; offline clients can continue using a cached copy. Communicate the withdrawal and limitations. Do not publish a replacement until it passes all build, approval, artifact and matrix gates.
