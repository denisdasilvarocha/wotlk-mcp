import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canonicalTableHash } from './canonical-table-hash.ts'

const [database, notice] = process.argv.slice(2)
if (!database || !notice || process.argv.length !== 4)
  throw new Error('Usage: reference-provenance <sqlite-path> <notice-output-path>')
if (path.resolve(database) === path.resolve(notice)) throw new Error('Notice must not overwrite the database')

const db = new DatabaseSync(database, { open: true, readOnly: false })
const temporaryNotice = `${notice}.${process.pid}.tmp`
try {
  db.exec('BEGIN IMMEDIATE')
  if (db.prepare("SELECT 1 FROM source WHERE name = 'client-data'").get()) {
    const bundleHash = '9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136'
    const tag = 'client-inputs-12340-engb-1'
    db.prepare(`INSERT INTO source VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET pin=excluded.pin, sha256=excluded.sha256,
        licence=excluded.licence, attribution=excluded.attribution`).run(
      'client-input-bundle', tag, bundleHash,
      'Blizzard-derived; redistribution risk accepted, permission not established',
      'Published verified enGB client-inputs asset for build 12340. Original trusted executable SHA-256: aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8. This is not the large-address-aware executable variant; enGB is an English stand-in, not verified byte-identical enUS.'
    )
    const pinsRow = db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()
    if (!pinsRow || typeof pinsRow.value !== 'string') throw new Error('Reference input pins are missing')
    const pins = JSON.parse(pinsRow.value)
    const manifestHash = createHash('sha256').update(readFileSync('data/client-inputs/manifest.json')).digest('hex')
    if (pins.client_inputs !== manifestHash)
      throw new Error('Client manifest pin does not match the published client-inputs asset manifest')
    pins.client_inputs_asset = { tag, sha256: bundleHash }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
  }
  const append = db.prepare('UPDATE source SET attribution = attribution || ? WHERE name = ? AND instr(attribution, ?) = 0')
  const addNotice = (name: string, heading: string, text: string): void => {
    append.run(`\n\n${heading}\n${text.trim()}\n`, name, heading)
  }
  const sources = new Set(db.prepare('SELECT name FROM source').all().map((row) => String(row.name)))
  if (sources.has('wowdbdefs'))
    addNotice('wowdbdefs', 'WoWDBDefs licence text:', readFileSync('data/wowdbdefs-LICENSE.txt', 'utf8'))
  if (sources.has('world')) {
    addNotice('world', 'AzerothCore authors:', readFileSync('world/azerothcore-AUTHORS.txt', 'utf8'))
    addNotice('world', 'AzerothCore licence text:', readFileSync('world/azerothcore-LICENSE.txt', 'utf8'))
  }
  for (const name of ['client-data', 'interface', 'native-registrations']) {
    if (sources.has(name))
      addNotice(name, 'Client rights and locale:', 'The owner accepts the redistribution risk; this is not evidence of Blizzard permission. The verified enGB extraction is an English stand-in for enUS, not proof of byte-identical enUS content.')
  }
  if (sources.has('codex'))
    addNotice('codex', 'Codex rights:', 'The owner accepts the unlicensed Codex redistribution risk; permission has not been established.')

  const manifest = db.prepare('SELECT name, pin, sha256, licence, attribution FROM source ORDER BY name COLLATE BINARY').all()
  if (!manifest.length) throw new Error('Source manifest is empty')
  const output = '# Database source notices\n\nThe reference database contains mixed-rights data; the package MIT licence does not grant rights to all database contents.\n\n' +
    manifest.map((row) => `## ${row.name}\n\nPin: ${row.pin}\n\nSHA-256: ${row.sha256}\n\nLicence: ${row.licence}\n\nAttribution and notices:\n\n${row.attribution}\n`).join('\n')

  const metadata = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta' ORDER BY name COLLATE BINARY").all()
  for (const table of tables) {
    const name = String(table.name)
    const { hash, count } = canonicalTableHash(db, name)
    metadata.run(`canonical_hash.${name}`, hash)
    metadata.run(`canonical_count.${name}`, count)
  }
  writeFileSync(temporaryNotice, output, { flag: 'wx' })
  db.exec('COMMIT')
  renameSync(temporaryNotice, notice)
} catch (error) {
  if (db.isTransaction) db.exec('ROLLBACK')
  throw error
} finally {
  rmSync(temporaryNotice, { force: true })
  db.close()
}
