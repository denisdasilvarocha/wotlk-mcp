import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../src/database.ts'
import { parseLayout } from './client-layout.ts'
import { importTable } from './client-table.ts'
import type { SourceArchive } from './sources.ts'

type ManifestFile = Readonly<{ path: string; sha256: string }>
type Manifest = Readonly<{
  client: Readonly<{ build: number; locale: string; original_executable_sha256: string }>
  files: readonly ManifestFile[]
}>

const kinds: Readonly<Record<string, string>> = {
  Achievement: 'achievement',
  AreaTable: 'area',
  ChrClasses: 'class',
  ChrRaces: 'race',
  Faction: 'faction',
  ItemSet: 'itemset',
  Map: 'map',
  SkillLine: 'skillline',
  Spell: 'spell',
  Talent: 'talent'
}

function hash(data: Readonly<Pick<Buffer, 'subarray'>>): string {
  return createHash('sha256').update(data.subarray()).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManifestFile(value: unknown): value is ManifestFile {
  return isObject(value) && typeof value.path === 'string' && typeof value.sha256 === 'string'
}

function readManifest(
  root: string,
  manifestHash: string,
  definitions: Readonly<SourceArchive>
): Manifest {
  const manifestBytes = readFileSync(path.join(root, 'manifest.json'))
  if (hash(manifestBytes) !== manifestHash) {
    throw new Error('Client manifest hash mismatch')
  }
  if (hash(readFileSync(definitions.archive)) !== definitions.sha256) {
    throw new Error('WoWDBDefs archive hash mismatch')
  }
  const manifest: unknown = JSON.parse(manifestBytes.toString())
  if (
    !isObject(manifest) ||
    !isObject(manifest.client) ||
    manifest.client.build !== 12340 ||
    manifest.client.locale !== 'enGB' ||
    manifest.client.original_executable_sha256 !==
      'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
  ) {
    throw new Error('Client manifest has an incompatible build, locale or executable fingerprint')
  }
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.every((entry: unknown) => isManifestFile(entry))
  ) {
    throw new TypeError('Invalid client manifest files')
  }
  return {
    client: {
      build: manifest.client.build,
      locale: manifest.client.locale,
      original_executable_sha256: manifest.client.original_executable_sha256
    },
    files: manifest.files
  }
}

function importFiles(
  db: Database,
  root: string,
  definitionsDirectory: string,
  definitionFiles: Readonly<Pick<ReadonlyMap<string, string>, 'get'>>,
  files: readonly ManifestFile[]
): void {
  const statements = {
    foreign: db.prepare('INSERT INTO dbc_foreign_key VALUES (?, ?, ?, ?)'),
    fts: db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)'),
    record: db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
  }
  const imported = new Set<string>()
  for (const entry of files.filter((f) => /^DBFilesClient\/[^/]+\.dbc$/iu.test(f.path))) {
    if (!/^DBFilesClient\/[A-Za-z0-9_]+\.dbc$/u.test(entry.path)) {
      throw new Error(`Invalid DBC path: ${entry.path}`)
    }
    const name = path.basename(entry.path, '.dbc')
    const data = readFileSync(path.join(root, entry.path))
    if (hash(data) !== entry.sha256) {
      throw new Error(`Client hash mismatch: ${entry.path}`)
    }
    const file = definitionFiles.get(`${name}.dbd`.toLowerCase())
    if (file === undefined || file === '') {
      throw new Error(`Missing definition: ${name}`)
    }
    const definition = readFileSync(path.join(definitionsDirectory, file), 'utf8')
    const fields = parseLayout(definition, name, Boolean(kinds[name]))
    if (fields === undefined) {
      continue
    }
    importTable(db, data, fields, name, entry.path, kinds[name], statements)
    imported.add(name)
  }
  for (const name of [...Object.keys(kinds), 'TalentTab']) {
    if (!imported.has(name)) {
      throw new Error(`Missing required Client Data layout or file: ${name}`)
    }
  }
}

function writeMetadata(
  db: Database,
  definitions: Readonly<SourceArchive>,
  manifestHash: string
): void {
  db.exec(`ALTER TABLE dbc_Talent ADD COLUMN TalentTab_Name_lang TEXT;
      UPDATE dbc_Talent SET TalentTab_Name_lang = COALESCE((SELECT Name_lang FROM dbc_TalentTab WHERE dbc_TalentTab.ID = dbc_Talent.TabID), '');
      UPDATE record SET
        name = COALESCE((SELECT s.Name_lang FROM dbc_Talent t JOIN dbc_Spell s ON s.ID = t.SpellRank_1 WHERE t.rowid = record.source_row), name),
        search_text = COALESCE((SELECT s.Description_lang FROM dbc_Talent t JOIN dbc_Spell s ON s.ID = t.SpellRank_1 WHERE t.rowid = record.source_row), ''),
        hint = COALESCE((SELECT TalentTab_Name_lang FROM dbc_Talent WHERE rowid = record.source_row), '')
      WHERE kind = 'talent';
      DELETE FROM record_fts WHERE id IN (SELECT id FROM record WHERE kind = 'talent');
      INSERT INTO record_fts SELECT id, name, search_text FROM record WHERE kind = 'talent'`)
  const pins: unknown = JSON.parse(
    String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value ?? '{}')
  )
  if (!isObject(pins)) {
    throw new TypeError('Invalid input pins')
  }
  pins.wowdbdefs = definitions.revision
  pins.client_inputs = manifestHash
  db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'wowdbdefs',
    definitions.revision,
    definitions.sha256,
    'CC BY-SA 4.0',
    'WoWDBDefs Contributors; https://github.com/wowdev/WoWDBDefs; definitions transformed into SQLite columns and foreign-key metadata'
  )
  db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
    'client-data',
    '12340 enGB',
    manifestHash,
    'Blizzard-derived; redistribution risk accepted',
    'Fingerprint-verified client extraction; enGB English stand-in, not verified byte-identical to enUS'
  )
}

export function importClientData(
  database: string,
  root: string,
  manifestHash: string,
  definitions: Readonly<SourceArchive>
): void {
  const manifest = readManifest(root, manifestHash, definitions)
  const definitionsDirectory = path.join(definitions.directory, 'definitions')
  const definitionNames = readdirSync(definitionsDirectory)
  // WoWDBDefs casing differs from client names (BannedAddons.dbd for BannedAddOns.dbc).
  const definitionFiles = new Map(definitionNames.map((file) => [file.toLowerCase(), file]))
  if (definitionFiles.size !== definitionNames.length) {
    throw new Error('Ambiguous WoWDBDefs definitions differing only in case')
  }
  const db = new DatabaseSync(database)
  db.exec('BEGIN')
  try {
    db.exec(
      'CREATE TABLE dbc_foreign_key (source_table TEXT NOT NULL, field TEXT NOT NULL, target_table TEXT NOT NULL, target_field TEXT NOT NULL)'
    )
    importFiles(db, root, definitionsDirectory, definitionFiles, manifest.files)
    writeMetadata(db, definitions, manifestHash)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
