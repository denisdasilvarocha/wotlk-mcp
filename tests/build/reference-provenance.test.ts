import { initReference } from '../../build/offsets.ts'
import { writeProvenance } from '../../build/reference/provenance.ts'
import { codexNames, hashCodex } from '../../build/sources/index.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

import type { Sources } from '../../build/sources/index.ts'

const nativeExecutable = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
const nativeDigest = '743f612075f238ad9b869d6a65d2860f372878451b8f558ab76999881a2e7861'

function fixtureArchive(directory: string, name: string): Sources['azerothcore'] {
  const archive = path.join(directory, `${name}.tar.gz`)
  const bytes = `Fixture archive: ${name}`
  writeFileSync(archive, bytes)
  return { archive, directory, revision: digest(name).slice(0, 40), sha256: digest(bytes) }
}

function fixtureSources(directory: string): Sources {
  const manifest = readFileSync('data/client-inputs/manifest.json')
  writeFileSync(path.join(directory, 'manifest.json'), manifest)
  mkdirSync(path.join(directory, 'src/data'), { recursive: true })
  for (const name of codexNames) {
    writeFileSync(path.join(directory, 'src/data', `${name}.ts`), name)
  }

  writeFileSync(path.join(directory, 'LICENSE.md'), 'Fixture definitions licence')
  writeFileSync(path.join(directory, 'LICENSE'), 'Fixture world licence')
  writeFileSync(path.join(directory, 'AUTHORS'), 'Fixture world authors')

  return {
    azerothcore: fixtureArchive(directory, 'world'),
    client: directory,
    clientManifestHash: digest(manifest),
    codex: { directory, revision: 'c'.repeat(40), ...hashCodex(directory) },
    codexNodeImage: `node@sha256:${'d'.repeat(64)}`,
    worldImporterImage: `acore/ac-wotlk-db-import@sha256:${'e'.repeat(64)}`,
    wowdbdefs: fixtureArchive(directory, 'wowdbdefs')
  }
}

function fixtureDatabase(database: string, inputs: Readonly<Sources>): DatabaseSync {
  initReference(database)
  const db = new DatabaseSync(database)
  const source = db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)')
  const manifestHash = inputs.clientManifestHash

  for (const [name, pin, sha256] of [
    ['wowdbdefs', inputs.wowdbdefs.revision, inputs.wowdbdefs.sha256],
    ['world', inputs.azerothcore.revision, inputs.azerothcore.sha256],
    ['codex', inputs.codex.revision, inputs.codex.sha256],
    ['client-data', '12340 enGB', manifestHash],
    ['interface', 'build 12340 enGB', manifestHash],
    ['native-registrations', nativeExecutable, nativeDigest]
  ] as const) {
    source.run(name, pin, sha256, 'Fixture licence', 'Fixture attribution')
  }

  const offsets = metadata(db).build_commit
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(
    JSON.stringify({
      offsets,
      client_inputs: manifestHash,
      codex: inputs.codex.revision,
      native: nativeDigest,
      native_manifest: manifestHash,
      world: inputs.azerothcore.revision,
      wowdbdefs: inputs.wowdbdefs.revision
    })
  )
  const insertMeta = db.prepare('INSERT INTO meta VALUES (?, ?)')
  insertMeta.run('hash.interface_manifest', manifestHash)
  insertMeta.run('world.importer_image', inputs.worldImporterImage)
  return db
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
    const inputs = fixtureSources(dir)
    const db = fixtureDatabase(database, inputs)
    db.exec(
      "INSERT INTO meta VALUES ('hash.sample', 'original-export-proof'), ('count.sample', 'original-count'); CREATE TABLE sample (value); INSERT INTO sample VALUES (42); CREATE TABLE typed (value); INSERT INTO typed VALUES (NULL), (42), (42.5), ('42'), (x'3432')"
    )

    db.close()

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
    expect(JSON.parse(String(initial.input_pins))).toMatchObject({
      codex_node_image: `node@sha256:${'d'.repeat(64)}`,
      world_importer_image: `acore/ac-wotlk-db-import@sha256:${'e'.repeat(64)}`
    })

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

test.each([
  ["UPDATE source SET sha256 = 'manifest-hash' WHERE name = 'client-data'", 'client-data'],
  ["UPDATE source SET pin = 'wrong' WHERE name = 'interface'", 'interface'],
  [
    "UPDATE source SET sha256 = 'wrong' WHERE name = 'native-registrations'",
    'native-registrations'
  ],
  ["DELETE FROM source WHERE name = 'wowdbdefs'", 'wowdbdefs'],
  ["UPDATE source SET sha256 = 'wrong' WHERE name = 'world'", 'world'],
  ["UPDATE source SET pin = 'wrong' WHERE name = 'codex'", 'codex'],
  ["UPDATE source SET sha256 = 'wrong' WHERE name = 'offsets'", 'offsets'],
  ["UPDATE source SET pin = 'wrong' WHERE name = 'offsets'", 'offsets'],
  ["UPDATE meta SET value = 'wrong' WHERE key = 'build_commit'", 'build_commit'],
  ["UPDATE meta SET value = 'wrong' WHERE key = 'world.importer_image'", 'world.importer_image'],
  [
    "UPDATE meta SET value = 'wrong' WHERE key = 'hash.interface_manifest'",
    'hash.interface_manifest'
  ],
  [
    "UPDATE meta SET value = json_remove(value, '$.client_inputs') WHERE key = 'input_pins'",
    'client_inputs'
  ]
])('rejects %s before altering the manifest or writing a notice', (change, expected) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'provenance-invalid-'))

  try {
    const database = path.join(dir, 'reference.sqlite')
    const notice = path.join(dir, 'NOTICE.md')
    const inputs = fixtureSources(dir)
    const db = fixtureDatabase(database, inputs)
    db.exec(change)
    const sourcesBefore = db.prepare('SELECT * FROM source ORDER BY name').all()
    const metadataBefore = metadata(db)
    db.close()

    expect(() => {
      writeProvenance(database, notice, inputs)
    }).toThrow(expected)

    const result = new DatabaseSync(database, { readOnly: true })

    expect(result.prepare('SELECT * FROM source ORDER BY name').all()).toEqual(sourcesBefore)
    expect(metadata(result)).toEqual(metadataBefore)
    result.close()
    expect(existsSync(notice)).toBe(false)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test.each([
  ['manifest.json', 'Client manifest SHA-256 mismatch'],
  ['wowdbdefs.tar.gz', 'wowdbdefs'],
  ['world.tar.gz', 'world'],
  ['src/data/api-functions.ts', 'Codex SHA-256 mismatch']
])('rejects changed acquired bytes in %s', (file, expected) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'provenance-changed-'))

  try {
    const database = path.join(dir, 'reference.sqlite')
    const notice = path.join(dir, 'NOTICE.md')
    const inputs = fixtureSources(dir)
    fixtureDatabase(database, inputs).close()
    writeFileSync(path.join(dir, file), 'changed bytes')

    expect(() => {
      writeProvenance(database, notice, inputs)
    }).toThrow(expected)
    expect(existsSync(notice)).toBe(false)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
