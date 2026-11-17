import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vite-plus/test'

import { writeProvenance } from '../build/provenance.ts'
import type { Sources } from '../build/sources.ts'
import { schema } from '../src/schema.ts'

function fixtureSources(directory: string): Sources {
  const archive = { archive: '', directory, revision: '', sha256: '' }

  writeFileSync(path.join(directory, 'LICENSE.md'), 'Fixture definitions licence')
  writeFileSync(path.join(directory, 'LICENSE'), 'Fixture world licence')
  writeFileSync(path.join(directory, 'AUTHORS'), 'Fixture world authors')

  return {
    azerothcore: archive,
    client: '',
    clientManifestHash: digest(readFileSync('data/client-inputs/manifest.json')),
    codex: { directory, files: {}, revision: '', sha256: '' },
    codexNodeImage: '',
    worldImporterImage: '',
    wowdbdefs: archive
  }
}

function digest(value: string | ArrayLike<number>): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex')
}

function metadata(result: Readonly<Pick<DatabaseSync, 'prepare'>>): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const row of result.prepare('SELECT key, value FROM meta').all()) {
    values[String(row.key)] = row.value
  }
  return values
}

test('final provenance hashes typed logical tables and emits notices from the embedded manifest', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'provenance-'))

  try {
    const database = path.join(dir, 'reference.sqlite')
    const notice = path.join(dir, 'NOTICE.md')
    const db = new DatabaseSync(database)

    db.exec(schema)
    db.exec(
      "INSERT INTO meta VALUES ('input_pins', '{}'), ('hash.sample', 'original-export-proof'), ('count.sample', 'original-count'); CREATE TABLE sample (value); INSERT INTO sample VALUES (42); CREATE TABLE typed (value); INSERT INTO typed VALUES (NULL), (42), (42.5), ('42'), (x'3432')"
    )

    const source = db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)')

    source.run(
      'wowdbdefs',
      'definition-pin',
      'definition-hash',
      'CC BY-SA 4.0',
      'Definitions transformed into SQLite'
    )
    source.run(
      'world',
      'world-pin',
      'world-hash',
      'GPL-2.0-or-later',
      'AzerothCore; modified; corresponding source https://example.test/source'
    )
    source.run(
      'client-data',
      '12340 enGB',
      'manifest-hash',
      'Blizzard-derived',
      'Client extraction'
    )
    source.run('codex', 'codex-pin', 'codex-hash', 'Unlicensed', 'Codex authors')

    const manifestHash = digest(readFileSync('data/client-inputs/manifest.json'))

    db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(
      JSON.stringify({ client_inputs: manifestHash })
    )
    db.close()

    const inputs = fixtureSources(dir)

    writeProvenance(database, notice, inputs)

    const result = new DatabaseSync(database)

    const initial = metadata(result)

    expect(initial['hash.sample']).toBe('original-export-proof')
    expect(initial['count.sample']).toBe('original-count')
    expect(initial['canonical_count.sample']).toBe('1')
    expect(initial['canonical_hash.sample']).toBe(digest('v14:wotlk-table-v1c5:valueri2:42'))
    expect(initial['canonical_count.typed']).toBe('5')
    expect(initial['canonical_hash.source']).toMatch(/^[a-f0-9]{64}$/u)
    expect(initial['canonical_hash.meta']).toBeUndefined()
    expect(initial['canonical_hash.record_fts']).toBeUndefined()
    expect(initial['canonical_hash.record_fts_data']).toBeUndefined()

    const text = readFileSync(notice, 'utf8')

    expect(text).toContain('Fixture definitions licence')
    expect(text).toContain('Fixture world licence')
    expect(text).toContain('Fixture world authors')
    expect(text).toContain('not evidence of Blizzard permission')
    expect(text).toContain('not proof of byte-identical enUS')
    expect(text).toContain('client-inputs-12340-engb-1')
    expect(text).toContain('9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136')
    expect(text).toContain('aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8')
    writeProvenance(database, notice, inputs)
    expect(metadata(result)['canonical_hash.source']).toBe(initial['canonical_hash.source'])
    expect(readFileSync(notice, 'utf8')).toBe(text)
    result.exec(
      "DELETE FROM typed; INSERT INTO typed VALUES (x'3432'), ('42'), (42.5), (42), (NULL)"
    )
    writeProvenance(database, notice, inputs)
    expect(metadata(result)['canonical_hash.typed']).toBe(initial['canonical_hash.typed'])
    result.exec("UPDATE typed SET value = '42' WHERE typeof(value) = 'integer'")
    writeProvenance(database, notice, inputs)
    expect(metadata(result)['canonical_hash.typed']).not.toBe(initial['canonical_hash.typed'])
    result.close()
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('a mismatched client pin fails without altering the manifest or writing a notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'provenance-invalid-'))

  try {
    const database = path.join(dir, 'reference.sqlite')
    const notice = path.join(dir, 'NOTICE.md')
    const db = new DatabaseSync(database)

    db.exec(schema)
    db.exec(
      "INSERT INTO meta VALUES ('input_pins', '{}'); INSERT INTO source VALUES ('client-data', 'pin', 'hash', 'licence', 'attribution')"
    )
    db.close()
    expect(() => {
      writeProvenance(database, notice, fixtureSources(dir))
    }).toThrow('Client manifest pin does not match')

    const result = new DatabaseSync(database, { readOnly: true })

    expect(result.prepare('SELECT name FROM source').all()).toEqual([{ name: 'client-data' }])
    expect(result.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()).toMatchObject({
      value: '{}'
    })
    result.close()
    expect(existsSync(notice)).toBe(false)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
