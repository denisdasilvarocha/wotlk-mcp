# Release operations

Use the manual [Release workflow](../.github/workflows/package-release.yml) to publish the reference database alone or together with the npm package. Database releases use `db-v<major>.<minor>.<patch>` tags; package releases use `v<version>` tags. Installed servers pick up a new database on their next update check, without a package release.

## Rules for every release

- Release assets are immutable. Never overwrite an asset, edit a published database, or reuse a tag for different contents. A correction is a new version that passes every gate again. GitHub enforces this: the repository enables immutable releases, and the `Release tags` ruleset blocks moving or deleting any tag.
- Release tags are never reused, including tags of deleted or failed drafts.
- Keep old database releases available; older package majors still download them.

## Authorize database publication

The workflow refuses to publish a database until the repository owner sets up the `database-publication` environment:

1. Add the repository owner as the environment's only required reviewer. The release script reads the environment through the GitHub API and fails without this rule.
2. Disable administrator bypass and restrict deployments to `main`.
3. Add the environment secret `DATABASE_RELEASE_AUTHORIZATION` with the value `owner-authorized`. Do not create a repository or organization secret with that name.

The owner then approves each protected job: the candidate build and the promotion.

## Run a release

Only the repository owner can run the workflow, and only on `main`. Choose `operation`: `prepare` is the default, `publish` releases a package and database, and `database-only` releases a database without a package release. Runs are serialized.

To create or update the ordinary release pull request, run:

```sh
gh workflow run package-release.yml --ref main -f operation=prepare
```

Review the release pull request and merge it through the normal CI requirements. Merging it does not create a tag or release and does not dispatch publication. After the merge, publish the package and database from the tagged commit:

```sh
gh workflow run package-release.yml --ref main -f operation=publish
```

For a database-only release, use the dispatched `main` commit instead; no package pull request, package draft, or npm publication is involved:

```sh
gh workflow run package-release.yml --ref main -f operation=database-only
```

For either publishing mode, append `-f allow-shrink=true` to the command only when the shrink is intentional. The owner must approve both protected `database-publication` jobs: candidate and promotion.

For `publish`, Release Please creates the package tag and draft after the release pull request has merged. The workflow builds the database and one npm tarball from that tagged commit. For `database-only`, it builds from the dispatched `main` commit. The candidate job runs the release gate and uploads the database to a draft release. All six acceptance jobs download that draft asset, verify its digest, and test it with the same packed CLI on Ubuntu, macOS, and Windows with Node 24.15.0 and the current Node release. After all six pass and the owner approves promotion, the workflow publishes the database. In `publish` mode, it then checks package and database compatibility, attests and uploads the same npm tarball, publishes it through npm trusted publishing, and publishes the package draft.

Release metadata may contain null digests for unrelated assets. The selected database asset must still have a valid SHA-256 digest, and newly uploaded assets must match their local file hashes.

### Recover a failed release

If a run fails after creating a draft, investigate and use **Re-run failed jobs** in that same GitHub Actions run. Do not start a new dispatch to recover that draft. Never replace a published asset or reuse a tag; if a version cannot pass its checks, leave its tag reserved and release a new version. A failed database draft remains unpublished.

If npm publication succeeds but the final GitHub release promotion fails, do not repeat npm publication. The owner must publish the existing package draft instead:

```sh
gh release edit vX.Y.Z --draft=false --latest
```

Replace `vX.Y.Z` with the existing package tag.

### Release gate

`scripts/release-gate.ts` checks the candidate database against the previous published one. It fails on:

- A failed SQLite integrity check, missing source tables, unresolved source rows, or a missing or empty provenance manifest.
- Missing Record kinds or Link relations, or names outside the known vocabulary.
- Search index counts that do not match their tables.
- Any table whose row count drops more than 5 percent, unless `--allow-shrink` is passed. The override waives this check only.
- Table contents that changed while every input pin stayed the same.
- A compressed asset over 250 MB, or one that does not decompress to the candidate.

The gate also assigns the database version by comparing the candidate with the previous release. Removing a table, changing a column type, removing a Record kind, or giving an existing source row a different Record ID is a major bump. Adding a table, column, or Record kind is a minor bump. Anything else is a patch. The version is then raised above every version already used in that major, including drafts, prereleases, and plain Git tags. A major bump needs a new package major, because each package major accepts one schema major.

Stable-ID comparisons use temporary, per-source key projections; neither database's schema nor source rows are modified.

### Prepare a candidate locally

The release commands need these variables:

```sh
export GITHUB_REPOSITORY=denisdasilvarocha/wotlk-mcp
export GITHUB_TOKEN=<token with access to this repository's releases>
```

1. Build into a new directory:

   ```sh
   vp run build ./candidate
   ```

2. Download the newest published database and list every reserved version:

   ```sh
   node scripts/database-release.mjs previous previous.sqlite versions.json
   ```

3. Run the gate, write the version, and recompress the asset:

   ```sh
   vpx scripts/prepare-reference.ts candidate previous.sqlite --used-versions=versions.json
   ```

   If no database has ever been published, omit `previous.sqlite`. The command updates `wotlk.sqlite.br` and `build-report.json`, and writes `gate.json`.

A local candidate is for investigation only. Publication always goes through the workflow, which tests the uploaded draft asset.

### Acceptance

The acceptance command runs the packed CLI against a candidate database and checks the cited fixtures in `tests/fixtures/acceptance.json`:

```sh
vp pack
vp pm pack
vpx scripts/acceptance.ts wotlk-mcp-1.0.0.tgz candidate/wotlk.sqlite tests/fixtures/acceptance.json
```

`data/world-acceptance-approval.json` currently records an approved review of the World Data fixtures. Before publishing, check that the approval still matches `tests/fixtures/acceptance.json` and its World Data cases. If the fixtures change, a maintainer must review them and record a new approval:

| Field             | Value                             |
| ----------------- | --------------------------------- |
| `status`          | `approved`                        |
| `reviewer`        | Reviewer name                     |
| `date`            | ISO date of the review            |
| `record`          | URL of a durable review record    |
| `fixtures_sha256` | SHA-256 of the exact fixture file |
| `world_cases`     | Every approved World Data case ID |

Any change to the fixture file needs a new approval.

## npm package releases

The `prepare` operation uses [Release Please](https://github.com/googleapis/release-please) to open or update an ordinary release pull request (`chore(main): release X.Y.Z`). The pull request sets `version` in `package.json` and adds a `CHANGELOG.md` entry from pull request titles merged since the last release. `feat` bumps the minor version, `fix` the patch version, and a breaking change (`!` or a `BREAKING CHANGE:` footer) the major version. Commits that only touch `.github/`, `build/`, `data/`, `docs/`, `scripts/`, or `tests/` do not count, because they do not change the package; `release-please-config.json` lists these paths.

The workflow authenticates as the repository's GitHub App (variable `APP_CLIENT_ID`, secret `APP_PRIVATE_KEY`) so release pull requests run CI. Dependabot auto-merge also uses the App; it requires the private key in Dependabot secrets and queues only verified minor or patch updates behind `ci-ok` and `pr-title`.

### One-time npm setup

npm trusted publishing requires an existing package. This setup is done; it is recorded here in case the trust configuration must be recreated:

1. The unscoped `wotlk-mcp` package was created by publishing a placeholder `0.0.0` by hand, outside the repository; npm also added its own `0.0.0-stage` placeholder for the new package. Both are deprecated and contain no server.
2. The package has a GitHub Actions trusted publisher for `npm publish` (npm always allows `npm stage publish` too): user `denisdasilvarocha`, repository `wotlk-mcp`, workflow `package-release.yml`, no environment, no dist-tag management. To recreate it, run `npm trust github wotlk-mcp --file package-release.yml --repo denisdasilvarocha/wotlk-mcp --allow-publish` with an account that uses two-factor authentication. npm discards a new trust configuration that is not used within two days.

### Publish a version

1. Check the fixture approval and review the candidate changes. If the schema major changed, the pull request that changes it must update both `acceptedSchemaMajor` in `src/schema.ts` and `wotlkSchemaMajor` in `package.json`, and mark its title as breaking (`feat!: ...`) so the release is a new package major. Mark a breaking change to a tool's parameters or output as breaking too.
2. Run `prepare`, then review and merge the release pull request through CI. To choose the version yourself, add a `Release-As: X.Y.Z` line to the body of a pull request merged before it.
3. Run `publish` on `main` and approve the database candidate and promotion jobs as the owner. The workflow creates and tests the compatible database before publishing the npm package.

The package compatibility check in `scripts/check-package-release.mjs` fails if:

- The tag does not equal `v` plus the `package.json` version.
- The two schema-major values disagree.
- The npm package does not exist, or this version is already published.
- An earlier version with the same package major used a different schema major.
- No published database exists for the package's schema major, or its asset fails the digest or schema check.

The workflow tests, attests, uploads, and publishes the same tarball used for database acceptance. Publishing outside the checkout keeps npm's publication step separate from the checkout's pnpm `devEngines` requirement. Follow [failed release recovery](#recover-a-failed-release) if a job fails.

## Roll back a database release

Rollback changes which release clients discover. It never changes published bytes. Get owner authorization first, and confirm that an earlier compatible database release is still published.

Set the operator environment:

```sh
export GITHUB_REPOSITORY=denisdasilvarocha/wotlk-mcp
export GITHUB_TOKEN=<token with write access to releases>
export DATABASE_RELEASE_AUTHORIZATION=owner-authorized
```

Look up the release ID for the bad tag, replacing `db-vX.Y.Z`:

```sh
gh api "repos/$GITHUB_REPOSITORY/releases/tags/db-vX.Y.Z" --jq '{id,tag_name,draft,prerelease}'
```

Then either mark it as a prerelease, which keeps it for investigation (preferred):

```sh
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z prerelease
```

Or, with explicit authorization, delete the release:

```sh
node scripts/database-release.mjs rollback RELEASE_ID db-vX.Y.Z delete
```

Deleting a release does not delete its Git tag; leave the tag in place so the version is never reused. Running servers keep their current database. Online clients switch to the newest remaining release after their next update check and restart; offline clients keep their cached copy. Tell users about the withdrawal and its limits.

## Client-input release

Release `client-inputs-12340-engb-1` holds the build inputs: DBC files, Interface source, and the native registration dump, but no client executable. Its asset `client-inputs-12340-engb-1.tar.gz` has SHA-256 `9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136`, and `build/sources/index.ts` pins its manifest hash. It was published once and is not part of the release workflow. Never replace its asset; changed inputs need a new release name. It was published before the repository enabled immutable releases, so GitHub does not lock its asset.
