import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

test('complete reference builder refuses an existing output without altering it', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'complete-reference-'))
  const marker = path.join(output, 'marker')
  writeFileSync(marker, 'keep')
  const result = spawnSync(process.execPath, ['scripts/complete-reference.ts', output], {
    encoding: 'utf8'
  })
  expect(result.status).not.toBe(0)
  expect(readFileSync(marker, 'utf8')).toBe('keep')
})

function runScenario(
  mode: string,
  check: (result: SpawnSyncReturns<string>, output: string) => void
): void {
  const temp = mkdtempSync(path.join(tmpdir(), 'complete-world-'))
  const bin = path.join(temp, 'bin')
  const output = path.join(temp, 'output')
  const state = path.join(temp, 'state')
  mkdirSync(bin)
  mkdirSync(state)
  const executables: Record<string, string> = {
    vpx: `case "$1" in
        scripts/reference-inputs.ts)
          mkdir -p "$2"
          touch "$2/verified-core.tar.gz"
          printf 'Verified fixture' > "$2/verified-client"
          printf 'Verified definitions' > "$2/verified-defs.tar.gz"
          printf '{"client":"%s/verified-client","clientManifestHash":"%s","clientBundle":"%s/bundle.tar.gz","wowdbdefs":"%s/verified-defs.tar.gz","azerothcore":"%s/verified-core.tar.gz","codex":"%s/verified-codex","codexRevision":"fixture"}\\n' "$2" "$WORLD_TEST_HASH" "$2" "$2" "$2" "$2" > "$2/inputs.json"
          ;;
        *) if [ "$WORLD_TEST_MODE" = success ]; then exec "$REAL_NODE" "$WORLD_TEST_ADAPTER" "$@"; fi
          echo 'intentional importer failure' >&2; exit 42 ;;
      esac`,
    node: 'exec "$REAL_NODE" "$WORLD_TEST_ADAPTER" "$@"',
    sh: `/bin/sh "$@" || exit $?
        if [ "$WORLD_TEST_MODE" = 'missing report' ]; then rm "$3/report.txt"; fi`,
    openssl: `case "$*" in
        *dbimport-build.patch*) echo f6b3c5c896d67271b53fc5c98896d12d2f188ead9e66007da6d2ed067a5d2eb9 ;;
        *) echo 748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9 ;;
      esac`,
    tar: 'mkdir -p "$4/data/sql/custom" "$4/modules"',
    patch: 'cat >/dev/null',
    docker: `case "$*" in
        'network create '*) touch "$WORLD_TEST_STATE/network" ;;
        'network rm '*) rm -f "$WORLD_TEST_STATE/network" ;;
        'rm -f '*) rm -f "$WORLD_TEST_STATE/container"
          [ "$WORLD_TEST_MODE" != 'container removal failure' ] || exit 1 ;;
        'run -d '*) touch "$WORLD_TEST_STATE/container" ;;
        *'SELECT 1'*) exit 0 ;;
        *--skip-column-names*)
          sql=$(cat)
          case "$sql" in *information_schema.columns*) part=columns ;; *) part=indexes ;; esac
          cat "$WORLD_TEST_ROOT/schema-$part.tsv"
          ;;
      esac`
  }
  for (const [name, body] of Object.entries(executables))
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  writeFileSync(
    path.join(temp, 'adapter.mjs'),
    `
      import { createHash } from 'node:crypto'
      import { DatabaseSync } from 'node:sqlite'
      import { readFileSync, writeFileSync } from 'node:fs'
      const [stage, database, ...args] = process.argv.slice(2)
      const db = new DatabaseSync(database)
      db.exec('CREATE TABLE IF NOT EXISTS record(id TEXT, name TEXT, definition TEXT)')
      if (stage === 'scripts/import-client-data.ts') {
        const contents = readFileSync(args[0])
        if (createHash('sha256').update(contents).digest('hex') !== args[1])
          throw new Error('Fixture manifest mismatch')
        db.prepare('INSERT INTO record VALUES (?, ?, ?)').run(
          'spell:1', contents.toString(), readFileSync(args[2], 'utf8')
        )
      }
      db.close()
      if (stage === 'scripts/reference-fidelity.ts') writeFileSync(args[0], '{"fidelity":"fixture"}')
      if (stage === 'scripts/reference-provenance.ts') writeFileSync(args[0], 'fixture notice')
    `
  )
  try {
    const result = spawnSync(process.execPath, ['scripts/complete-reference.ts', output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        WORLD_TEST_MODE: mode,
        WORLD_TEST_STATE: state,
        WORLD_TEST_HASH: createHash('sha256').update('Verified fixture').digest('hex'),
        WORLD_TEST_ROOT: path.resolve('world'),
        REAL_NODE: process.execPath,
        WORLD_TEST_ADAPTER: path.join(temp, 'adapter.mjs')
      }
    })
    expect(existsSync(path.join(output, 'world', 'schema-columns.tsv'))).toBe(true)
    expect(existsSync(path.join(state, 'container'))).toBe(false)
    expect(existsSync(path.join(state, 'network'))).toBe(false)
    check(result, output)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

test('complete reference cleans World Data when the human report is missing', () => {
  runScenario('missing report', (result) => {
    expect(result.status).not.toBe(0)
  })
})

test('complete reference attempts both removals and preserves the importer failure', () => {
  runScenario('container removal failure', (result) => {
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('intentional importer failure')
    expect(result.stderr).toContain('Command failed: vpx scripts/init-reference.ts')
  })
})

test('complete reference builds artifacts from verified inputs and cleans World Data', () => {
  runScenario('success', (result, output) => {
    expect(result.status).toBe(0)
    const database = path.join(output, 'wotlk.sqlite')
    expect(brotliDecompressSync(readFileSync(`${database}.br`))).toEqual(readFileSync(database))
    const db = new DatabaseSync(database, { readOnly: true })
    const record = db.prepare('SELECT id,name,definition FROM record').get()
    db.close()
    expect(record).toMatchObject({
      id: 'spell:1',
      name: 'Verified fixture',
      definition: 'Verified definitions'
    })
    expect(readFileSync(path.join(output, 'NOTICE.md'), 'utf8')).toBe('fixture notice')
    expect(JSON.parse(readFileSync(path.join(output, 'fidelity.json'), 'utf8'))).toEqual({
      fidelity: 'fixture'
    })
    expect(
      JSON.parse(readFileSync(path.join(output, 'build-report.json'), 'utf8')).compressed_bytes
    ).toBe(readFileSync(`${database}.br`).length)
  })
})
