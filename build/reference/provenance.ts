import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'
import { canonicalTableHash, canonicalTables } from '../shared/table-hash.ts'
import type { Sources } from '../sources/index.ts'

type ProvenanceSources = Readonly<Omit<Sources, 'azerothcore' | 'codex' | 'wowdbdefs'>> & {
  readonly azerothcore: Readonly<Sources['azerothcore']>
  readonly codex: Readonly<Omit<Sources['codex'], 'files'>> & {
    readonly files: Readonly<Record<string, string>>
  }
  readonly wowdbdefs: Readonly<Sources['wowdbdefs']>
}

function recordClientBundle(db: Database, clientManifestHash: string): void {
  if (!db.prepare("SELECT 1 FROM source WHERE name = 'client-data'").get()) {
    return
  }

  const bundleHash = '9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136'
  const tag = 'client-inputs-12340-engb-1'

  db.prepare(`INSERT INTO source VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET pin=excluded.pin, sha256=excluded.sha256,
        licence=excluded.licence, attribution=excluded.attribution`).run(
    'client-input-bundle',
    tag,
    bundleHash,
    'Blizzard-derived; redistribution risk accepted, permission not established',
    'Published verified enGB client-inputs asset for build 12340. Original trusted executable SHA-256: aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8. This is not the large-address-aware executable variant; enGB is an English stand-in, not verified byte-identical enUS.'
  )

  const pinsRow = db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()
  if (!pinsRow || typeof pinsRow.value !== 'string') {
    throw new Error('Reference input pins are missing')
  }

  const pins: unknown = JSON.parse(pinsRow.value)
  if (typeof pins !== 'object' || pins === null) {
    throw new Error('Reference input pins are missing')
  }
  const clientInputs = 'client_inputs' in pins ? pins.client_inputs : undefined
  const manifestHash = createHash('sha256')
    .update(readFileSync('data/client-inputs/manifest.json'))
    .digest('hex')

  if (clientInputs !== manifestHash || clientManifestHash !== manifestHash) {
    throw new Error('Client manifest pin does not match the published client-inputs asset manifest')
  }

  Object.assign(pins, { client_inputs_asset: { sha256: bundleHash, tag } })
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
}

function addNotice(
  append: Readonly<Pick<ReturnType<Database['prepare']>, 'run'>>,
  name: string,
  heading: string,
  text: string
): void {
  append.run(`\n\n${heading}\n${text.trim()}\n`, name, heading)
}

function addWorldNotices(
  append: Readonly<Pick<ReturnType<Database['prepare']>, 'run'>>,
  directory: string
): void {
  addNotice(
    append,
    'world',
    'AzerothCore authors:',
    readFileSync(path.join(directory, 'AUTHORS'), 'utf8')
  )
  addNotice(
    append,
    'world',
    'AzerothCore licence text:',
    readFileSync(path.join(directory, 'LICENSE'), 'utf8')
  )
}

function addSourceNotices(db: Database, inputs: ProvenanceSources): void {
  const append = db.prepare(
    'UPDATE source SET attribution = attribution || ? WHERE name = ? AND instr(attribution, ?) = 0'
  )
  const sources = new Set(
    db
      .prepare('SELECT name FROM source')
      .all()
      .map((row: Readonly<Record<string, unknown>>) => String(row.name))
  )

  if (sources.has('wowdbdefs')) {
    addNotice(
      append,
      'wowdbdefs',
      'WoWDBDefs licence text:',
      readFileSync(path.join(inputs.wowdbdefs.directory, 'LICENSE.md'), 'utf8')
    )
  }
  if (sources.has('world')) {
    addWorldNotices(append, inputs.azerothcore.directory)
  }
  for (const name of ['client-data', 'interface', 'native-registrations']) {
    if (sources.has(name)) {
      addNotice(
        append,
        name,
        'Client rights and locale:',
        'The owner accepts the redistribution risk; this is not evidence of Blizzard permission. The verified enGB extraction is an English stand-in for enUS, not proof of byte-identical enUS content. Fingerprint research (https://github.com/denisdasilvarocha/wotlk-mcp/issues/14) found Localization.lua and calendar first-weekday differences against an older enUS snapshot, and differences in 14 locale-sourced DBC text tables; those comparisons do not prove enUS identity. No locale corrections are silently applied.'
      )
    }
  }
  if (sources.has('codex')) {
    addNotice(
      append,
      'codex',
      'Codex rights:',
      'The owner accepts the unlicensed Codex redistribution risk; permission has not been established.'
    )
  }
}

function noticeOutput(db: Database): string {
  const manifest = db
    .prepare(
      'SELECT name, pin, sha256, licence, attribution FROM source ORDER BY name COLLATE BINARY'
    )
    .all()

  if (manifest.length === 0) {
    throw new Error('Source manifest is empty')
  }

  const details = manifest
    .map(
      (row: Readonly<Record<string, unknown>>) =>
        `## ${String(row.name)}\n\nPin: ${String(row.pin)}\n\nSHA-256: ${String(row.sha256)}\n\nLicence: ${String(row.licence)}\n\nAttribution and notices:\n\n${String(row.attribution)}\n`
    )
    .join('\n')
  return `# Database source notices\n\nThe reference database contains mixed-rights data; the package MIT licence does not grant rights to all database contents.\n\n${details}`
}

export function writeProvenance(database: string, notice: string, inputs: ProvenanceSources): void {
  if (path.resolve(database) === path.resolve(notice)) {
    throw new Error('Notice must not overwrite the database')
  }

  const db = new DatabaseSync(database, { open: true, readOnly: false })
  const temporaryNotice = `${notice}.${process.pid}.tmp`

  try {
    db.exec('BEGIN IMMEDIATE')

    recordClientBundle(db, inputs.clientManifestHash)
    addSourceNotices(db, inputs)

    const output = noticeOutput(db)
    const metadata = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )

    metadata.run('codex.node_image', inputs.codexNodeImage)

    for (const name of canonicalTables(db)) {
      const { hash, count } = canonicalTableHash(db, name)

      metadata.run(`canonical_hash.${name}`, hash)
      metadata.run(`canonical_count.${name}`, count)
    }

    writeFileSync(temporaryNotice, output, { flag: 'wx' })
    db.exec('COMMIT')
    renameSync(temporaryNotice, notice)
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  } finally {
    rmSync(temporaryNotice, { force: true })
    db.close()
  }
}
