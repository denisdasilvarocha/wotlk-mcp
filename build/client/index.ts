import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'
import { readClientManifest, type ClientManifestFile } from '../shared/client-manifest.ts'
import { isRecord } from '../shared/record.ts'
import { sha256Hex } from '../shared/sha256.ts'
import type { SourceArchive } from '../sources/index.ts'
import { parseLayout } from './layout.ts'
import { importTable } from './table.ts'

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

function importFiles(
  db: Database,
  root: string,
  definitionsDirectory: string,
  definitionFiles: Readonly<Pick<ReadonlyMap<string, string>, 'get'>>,
  files: readonly ClientManifestFile[]
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
    if (sha256Hex(data) !== entry.sha256) {
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
  if (!isRecord(pins)) {
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
  const files = readClientManifest(root, manifestHash)
  if (sha256Hex(readFileSync(definitions.archive)) !== definitions.sha256) {
    throw new Error('WoWDBDefs archive hash mismatch')
  }
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
    importFiles(db, root, definitionsDirectory, definitionFiles, files)
    writeMetadata(db, definitions, manifestHash)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
