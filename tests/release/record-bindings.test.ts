import { canonicalTableHash } from '../../build/shared/table-hash.ts'
import { createReleaseFixture, sealReleaseFixture } from '../helpers/release-fixture.ts'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'
import { afterAll, expect, test } from 'vite-plus/test'

const root = mkdtempSync(path.join(tmpdir(), 'record-bindings-'))
afterAll(() => {
  rmSync(root, { force: true, recursive: true })
})

function fixture(): { directory: string; candidate: string; previous: string } {
  const directory = mkdtempSync(path.join(root, 'candidate-'))
  const candidate = path.join(directory, 'wotlk.sqlite')
  const previous = path.join(directory, 'previous.sqlite')

  createReleaseFixture(candidate)
  const db = new DatabaseSync(candidate)
  db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('a'), ('b')")
  db.close()
  sealReleaseFixture(candidate)
  copyFileSync(candidate, previous)

  return { directory, candidate, previous }
}

function swapRowIds(database: string, table: 'entity' | 'unrelated'): void {
  const db = new DatabaseSync(database)
  db.exec(`UPDATE ${table} SET rowid=100 WHERE rowid=1;
    UPDATE ${table} SET rowid=1 WHERE rowid=2;
    UPDATE ${table} SET rowid=2 WHERE rowid=100;`)
  db.close()
}

function useLegacyRecordSeal(database: string): void {
  const db = new DatabaseSync(database)
  db.exec('CREATE TEMP TABLE legacy_record AS SELECT * FROM record')
  const { hash } = canonicalTableHash(db, 'legacy_record')
  db.prepare("UPDATE meta SET value=? WHERE key='canonical_hash.record'").run(hash)
  db.close()
}

test('rejects an artifact whose Records now resolve to different source values', () => {
  const { directory, candidate } = fixture()
  swapRowIds(candidate, 'entity')
  const asset = path.join(directory, 'wotlk.sqlite.br')
  writeFileSync(asset, brotliCompressSync(readFileSync(candidate)))

  const result = spawnSync('vpx', ['scripts/release-gate.ts', candidate, asset], {
    encoding: 'utf8'
  })

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Invalid canonical hash or count: record')
})

test('rejects resealed Record binding drift against an unchanged legacy baseline', () => {
  const { candidate, previous } = fixture()
  useLegacyRecordSeal(previous)
  swapRowIds(candidate, 'entity')
  sealReleaseFixture(candidate)

  const result = spawnSync(
    'vpx',
    ['scripts/release-gate.ts', candidate, `${candidate}.br`, previous, '--prepare'],
    { encoding: 'utf8' }
  )

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Unchanged input pins with logical drift: record')
})

test('prepares and verifies against a legacy baseline despite unrelated rowid changes', () => {
  const { directory, candidate, previous } = fixture()
  useLegacyRecordSeal(previous)
  const priorBytes = readFileSync(previous)
  swapRowIds(candidate, 'unrelated')
  writeFileSync(
    path.join(directory, 'build-report.json'),
    JSON.stringify({ build_seconds: 1, timings_seconds: {} })
  )

  const result = spawnSync('vpx', ['scripts/prepare-reference.ts', directory, previous], {
    encoding: 'utf8'
  })

  expect(result.stderr).not.toContain('Error:')
  expect(result.status).toBe(0)
  expect(readFileSync(path.join(directory, 'gate.json'), 'utf8')).toContain('"version":"1.0.1"')
  expect(readFileSync(previous)).toEqual(priorBytes)
})
