import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'

import { afterAll, expect, test } from 'vite-plus/test'

import { createReleaseFixture, sealReleaseFixture } from './release-fixture.ts'

const directory = mkdtempSync(path.join(tmpdir(), 'release-gate-'))
afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

function fixture(): string {
  const dir = mkdtempSync(path.join(directory, 'candidate-'))
  const file = path.join(dir, 'candidate.sqlite')

  createReleaseFixture(file)
  sealReleaseFixture(file)

  return file
}

function gate(file: string, ...args: readonly string[]): SpawnSyncReturns<string> {
  sealReleaseFixture(file)
  writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)))

  return spawnSync('vpx', ['scripts/release-gate.ts', file, `${file}.br`, ...args], {
    encoding: 'utf8'
  })
}

function version(output: string): unknown {
  const result: unknown = JSON.parse(output)
  if (typeof result !== 'object' || result === null || !('version' in result)) {
    throw new Error('Release result has no version')
  }
  return result.version
}

function previousArgs(candidate: string, hasPrevious: boolean): string[] {
  if (!hasPrevious) {
    return []
  }
  const previous = `${candidate}.previous`
  copyFileSync(candidate, previous)
  return [previous]
}

function applySql(db: Readonly<Pick<DatabaseSync, 'exec'>>, sql: string): void {
  if (sql) {
    db.exec(sql)
  }
}

function prepareShrink(db: Readonly<Pick<DatabaseSync, 'prepare'>>, dimension: string): void {
  if (dimension === 'relation') {
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO link VALUES ('event:1','starts','item:1',?)").run(String(i))
    }
  }
}

function addShrinkBaseline(db: Readonly<Pick<DatabaseSync, 'exec'>>, dimension: string): string {
  if (dimension === 'kind') {
    db.exec(
      "INSERT INTO record SELECT 'spell:2',kind,name,source_table,source_row,search_text,hint FROM record WHERE id='spell:1'; INSERT INTO record_fts SELECT 'spell:2',name,text FROM record_fts WHERE id='spell:1'"
    )
    return 'kind:spell'
  }
  db.exec("INSERT INTO link VALUES ('event:1','drops','item:1','')")
  return 'relation:drops'
}

test('first release checks a real complete artifact and emits version 1.0.0', () => {
  const file = fixture()
  const result = gate(file)

  expect(result.status).toBe(0)
  expect(version(result.stdout)).toBe('1.0.0')
})
test.each([
  ['first', '', false, ['1.0.0'], '1.0.1'],
  ['patch', '', true, ['1.0.1'], '1.0.2'],
  ['patch', '', true, ['1.0.9', '1.0.2', '2.0.0'], '1.0.10'],
  ['patch', '', true, ['1.2.0'], '1.2.1'],
  ['minor', 'ALTER TABLE entity ADD COLUMN extra TEXT', true, ['1.1.0'], '1.1.1'],
  ['major', 'ALTER TABLE entity DROP COLUMN ID', true, ['2.0.0'], '2.0.1']
])(
  'allocates a fresh %s version while preserving the published comparison baseline',
  (change, sql, hasPrevious, used: readonly string[], expected) => {
    const candidate = fixture()
    const args = previousArgs(candidate, hasPrevious)

    const db = new DatabaseSync(candidate)

    db.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')

    applySql(db, sql)
    db.close()

    const versions = `${candidate}.versions.json`

    writeFileSync(versions, JSON.stringify(used))
    args.push(`--used-versions=${versions}`)

    const prepared = gate(candidate, ...args, '--prepare')

    expect(prepared.status).toBe(0)

    const checked = gate(candidate, ...args)

    expect(checked.status).toBe(0)
    expect(JSON.parse(checked.stdout)).toMatchObject({ change, version: expected })
  }
)
test.each([{}, ['invalid'], [1]])('rejects invalid used versions %j', (used) => {
  const candidate = fixture()
  const versions = `${candidate}.versions.json`

  writeFileSync(versions, JSON.stringify(used))
  expect(gate(candidate, `--used-versions=${versions}`, '--prepare').status).not.toBe(0)
})
test.each([
  ['missing source', "UPDATE record SET source_row=999 WHERE id='spell:1'"],
  ['missing link endpoint', "UPDATE link SET destination_id='item:missing' WHERE relation='drops'"],
  ['kind coverage', "DELETE FROM record WHERE kind='spell'"],
  ['relation coverage', "DELETE FROM link WHERE relation='drops'"],
  ['native evidence', "UPDATE lua_native_registration SET va='0x00400001'"],
  ['Interface FTS coverage', 'DELETE FROM ui_line_fts'],
  ['duplicate IDs', "INSERT INTO record SELECT * FROM record WHERE id='spell:1'"],
  [
    'corrupt FTS index',
    "UPDATE record_fts_data SET block=X'00' WHERE id=(SELECT max(id) FROM record_fts_data)"
  ],
  ['FTS coverage', "DELETE FROM record_fts WHERE id='spell:1'"]
])('rejects %s', (_name, sql) => {
  const file = fixture()
  const db = new DatabaseSync(file)

  db.enableDefensive?.(false)
  db.exec(sql)
  db.close()

  const result = gate(file)

  expect(result.status).not.toBe(0)
})

test('compares previous versions, shrink, drift and explicit override', () => {
  const candidate = fixture()
  const previous = `${candidate}.previous`

  copyFileSync(candidate, previous)

  let db = new DatabaseSync(candidate)

  db.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')
  db.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(version(gate(candidate, previous).stdout)).toBe('1.0.1')
  db = new DatabaseSync(candidate)
  db.exec('ALTER TABLE entity ADD COLUMN extra TEXT')
  db.close()
  expect(gate(candidate, previous).status).not.toBe(0)
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(version(gate(candidate, previous).stdout)).toBe('1.1.0')
  db = new DatabaseSync(previous)
  db.exec('CREATE TABLE removed_table(value TEXT)')
  db.close()
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).toBe(0)
  expect(version(gate(candidate, previous, '--allow-shrink').stdout)).toBe('2.0.0')
  db = new DatabaseSync(previous)
  db.exec('DROP TABLE removed_table; INSERT INTO entity SELECT ID + 100, name FROM entity')
  db.close()
  expect(gate(candidate, previous, '--prepare').status).not.toBe(0)
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).toBe(0)
  expect(gate(candidate, previous, '--allow-shrink').status).toBe(0)
  db = new DatabaseSync(candidate)
  db.exec('UPDATE meta SET value=\'{"fixture":"one"}\' WHERE key=\'input_pins\'')
  db.close()
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).not.toBe(0)
})

test('rejects an oversized or mismatched compressed asset', () => {
  const file = fixture()
  const asset = `${file}.br`

  writeFileSync(asset, Buffer.alloc(0))
  truncateSync(asset, 250_000_001)

  const result = spawnSync('vpx', ['scripts/release-gate.ts', file, asset], { encoding: 'utf8' })

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('250 MB')
  writeFileSync(asset, brotliCompressSync(Buffer.from('wrong')))
  expect(spawnSync('vpx', ['scripts/release-gate.ts', file, asset]).status).not.toBe(0)
})

test('changed IDs for the same source Record require a major version', () => {
  const candidate = fixture()
  const previous = `${candidate}.previous`

  copyFileSync(candidate, previous)

  const db = new DatabaseSync(candidate)

  db.exec(
    "UPDATE meta SET value='{\"fixture\":\"two\"}' WHERE key='input_pins'; UPDATE record SET id='spell:renamed' WHERE id='spell:1'; UPDATE record_fts SET id='spell:renamed' WHERE id='spell:1'"
  )
  db.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(version(gate(candidate, previous).stdout)).toBe('2.0.0')
})
test('duplicate names and reordered physical rows do not change stable source identity', () => {
  const candidate = fixture()
  const db = new DatabaseSync(candidate)
  const previous = `${candidate}.previous`

  db.exec(
    "INSERT INTO entity VALUES (100,'duplicate'); UPDATE entity SET name='duplicate' WHERE ID=1; UPDATE record SET name='duplicate' WHERE id='spell:1'; UPDATE record_fts SET name='duplicate' WHERE id='spell:1'; INSERT INTO record VALUES ('spell:100','spell','duplicate','entity',26,'',''); INSERT INTO record_fts VALUES ('spell:100','duplicate','')"
  )
  db.close()
  sealReleaseFixture(candidate)
  copyFileSync(candidate, previous)

  const changed = new DatabaseSync(candidate)

  changed.exec(
    "UPDATE meta SET value='{\"fixture\":\"two\"}' WHERE key='input_pins'; UPDATE entity SET rowid=200 WHERE ID=1; UPDATE entity SET rowid=1 WHERE ID=100; UPDATE entity SET rowid=26 WHERE ID=1; UPDATE record SET source_row=CASE source_row WHEN 1 THEN 26 WHEN 26 THEN 1 ELSE source_row END WHERE kind='spell'"
  )
  changed.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(version(gate(candidate, previous).stdout)).toBe('1.0.1')
})

test('rejects invalid declared logical hashes', () => {
  const file = fixture()
  const db = new DatabaseSync(file)

  db.exec("UPDATE meta SET value='bad' WHERE key='canonical_hash.entity'")
  db.close()
  writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)))
  expect(spawnSync('vpx', ['scripts/release-gate.ts', file, `${file}.br`]).status).not.toBe(0)
})

test.each(['kind', 'relation'])('rejects %s shrink independently of table counts', (dimension) => {
  const candidate = fixture()
  let db = new DatabaseSync(candidate)

  prepareShrink(db, dimension)

  db.close()
  sealReleaseFixture(candidate)

  const previous = `${candidate}.previous`

  copyFileSync(candidate, previous)
  db = new DatabaseSync(previous)

  const expected = addShrinkBaseline(db, dimension)

  db.close()
  db = new DatabaseSync(candidate)
  db.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')
  db.close()

  const rejected = gate(candidate, previous, '--prepare')

  expect(rejected.status).not.toBe(0)

  expect(rejected.stderr).toContain(expected)
  expect(gate(candidate, previous, '--prepare', '--allow-shrink').status).toBe(0)
})
