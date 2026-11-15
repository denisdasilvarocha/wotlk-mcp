import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { SourceArchive } from './sources.ts'

function hash(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function quote(s: string): string {
  return `"${s.replaceAll('"', '""')}"`
}

function matchesBuild(text: string): boolean {
  return text.split(',').some((part) => {
    const [a, b = a] = part
      .trim()
      .split('-')
      .map((v) => v.split('.').map(Number))

    return (
      a?.length === 4 &&
      b?.length === 4 &&
      compare(a, [3, 3, 5, 12340]) <= 0 &&
      compare(b, [3, 3, 5, 12340]) >= 0
    )
  })
}

function compare(x: number[], y: number[]): number {
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

export function importClientData(
  database: string,
  root: string,
  manifestHash: string,
  definitions: SourceArchive
): void {
  const manifestBytes = readFileSync(path.join(root, 'manifest.json'))

  if (hash(manifestBytes) !== manifestHash) throw new Error('Client manifest hash mismatch')
  if (hash(readFileSync(definitions.archive)) !== definitions.sha256)
    throw new Error('WoWDBDefs archive hash mismatch')

  const manifest: {
    client: { build: number; locale: string; original_executable_sha256: string }
    files: { path: string; sha256: string }[]
  } = JSON.parse(manifestBytes.toString())

  if (
    manifest.client?.build !== 12340 ||
    manifest.client.locale !== 'enGB' ||
    manifest.client.original_executable_sha256 !==
      'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
  )
    throw new Error('Client manifest has an incompatible build, locale or executable fingerprint')

  {
    const definitionsDirectory = path.join(definitions.directory, 'definitions')
    const db = new DatabaseSync(database)
    db.exec('BEGIN')
    try {
      db.exec(
        'CREATE TABLE dbc_foreign_key (source_table TEXT NOT NULL, field TEXT NOT NULL, target_table TEXT NOT NULL, target_field TEXT NOT NULL)'
      )

      const foreign = db.prepare('INSERT INTO dbc_foreign_key VALUES (?, ?, ?, ?)')
      const kinds: Record<string, string> = {
        Spell: 'spell',
        Talent: 'talent',
        ItemSet: 'itemset',
        SkillLine: 'skillline',
        Map: 'map',
        AreaTable: 'area',
        Faction: 'faction',
        ChrClasses: 'class',
        ChrRaces: 'race',
        Achievement: 'achievement'
      }
      const record = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
      const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
      const imported = new Set<string>()

      for (const entry of manifest.files.filter((f) =>
        /^DBFilesClient\/[^/]+\.dbc$/i.test(f.path)
      )) {
        if (!/^DBFilesClient\/[A-Za-z0-9_]+\.dbc$/.test(entry.path))
          throw new Error(`Invalid DBC path: ${entry.path}`)

        const name = path.basename(entry.path, '.dbc')
        const data = readFileSync(path.join(root, entry.path))

        if (hash(data) !== entry.sha256) throw new Error(`Client hash mismatch: ${entry.path}`)

        let definition: string

        try {
          definition = readFileSync(path.join(definitionsDirectory, `${name}.dbd`), 'utf8')
        } catch {
          throw new Error(`Missing definition: ${name}`)
        }

        const sections = definition.split(/\r?\n\s*\r?\n/)
        const columns = new Map<string, { type: string; target?: string }>()

        for (const line of sections[0].split(/\r?\n/).slice(1)) {
          const match = /^(int|uint|float|string|locstring)(?:<([^>]+)>)?\s+(\w+)/.exec(line)

          if (match) columns.set(match[3], { type: match[1], target: match[2] })
        }

        const section = sections
          .slice(1)
          .find((part) =>
            part
              .split(/\r?\n/)
              .some((line) => line.startsWith('BUILD ') && matchesBuild(line.slice(6)))
          )

        if (!section) {
          if (kinds[name]) throw new Error(`Missing build 12340 layout: ${name}`)

          continue
        }

        const fields: {
          name: string
          type: string
          target?: string
          localized?: boolean
          size: number
          unsigned: boolean
        }[] = []

        for (const line of section.split(/\r?\n/)) {
          if (!line || /^(BUILD|LAYOUT|COMMENT) /.test(line)) continue

          const m = /^(?:\$([^$]+)\$)?(\w+)(?:<([^>]+)>)?(?:\[(\d+)\])?/.exec(line)

          if (!m) throw new Error(`Unrecognized ${name} layout: ${line}`)
          if (m[1]?.includes('noninline')) throw new Error(`Non-inline field in ${name}: ${line}`)

          const col = columns.get(m[2])

          if (!col) throw new Error(`Unrecognized ${name} layout: ${line}`)

          const count = Number(m[4] ?? 1)

          for (let i = 0; i < count; i++) {
            let [, , field] = m

            if (count !== 1) field = `${field}_${i + 1}`
            fields.push({
              name: field,
              type: col.type,
              target: col.target,
              localized: col.type === 'locstring',
              size: Number(m[3]?.replace('u', '') ?? 32) / 8,
              unsigned: col.type === 'uint' || (m[3]?.startsWith('u') ?? false)
            })
          }
        }

        if (data.toString('ascii', 0, 4) !== 'WDBC') throw new Error(`Invalid DBC: ${entry.path}`)

        const rows = data.readUInt32LE(4),
          slots = data.readUInt32LE(8),
          width = data.readUInt32LE(12),
          strings = data.readUInt32LE(16)
        const expected = fields.reduce(
          (n, field) => n + 1 + Number(Boolean(field.localized)) * 16,
          0
        )
        const expectedWidth = fields.reduce((n, field) => {
          if (field.localized) return n + 68

          return n + field.size
        }, 0)

        if (
          slots !== expected ||
          width !== expectedWidth ||
          data.length !== 20 + rows * width + strings
        )
          throw new Error(
            `DBC schema mismatch: ${name} (${slots} != ${expected}, width ${width} != ${expectedWidth})`
          )

        const expanded = fields.flatMap((f) => {
          if (!f.localized) return [f]

          return [
            f,
            ...Array.from({ length: 16 }, (_, i) => {
              let type = 'string'

              if (i === 15) type = 'int'

              return { ...f, name: `${f.name}_${i + 1}`, type, localized: false, target: undefined }
            })
          ]
        })
        const definitionsSql = expanded
          .map((f) => {
            let type = 'INTEGER'

            if (f.type === 'float') type = 'REAL'

            if (f.type.includes('string')) type = 'TEXT'

            return `${quote(f.name)} ${type}`
          })
          .join(', ')
        const table = `dbc_${name}`

        db.exec(`CREATE TABLE ${quote(table)} (${definitionsSql})`)
        imported.add(name)

        for (const f of fields)
          if (f.target) {
            const [target, key] = f.target.split('::')

            foreign.run(table, f.name, `dbc_${target}`, key ?? 'ID')
          }

        const insert = db.prepare(
          `INSERT INTO ${quote(table)} VALUES (${expanded.map(() => '?').join(',')})`
        )
        const logicalHash = createHash('sha256')
          .update(JSON.stringify(expanded.map((field) => [field.name, field.type])))
          .update('\n')
        const stringStart = 20 + rows * width

        function text(offset: number): string {
          if (offset >= strings) throw new Error(`Invalid string offset in ${name}`)

          const end = data.indexOf(0, stringStart + offset)

          if (end < 0 || end >= data.length) throw new Error(`Unterminated string in ${name}`)

          return data.toString('utf8', stringStart + offset, end)
        }

        for (let row = 0; row < rows; row++) {
          let cursor = 20 + row * width
          const values: (number | string)[] = []

          for (const f of expanded) {
            let value: number | string

            if (f.type === 'float') value = data.readFloatLE(cursor)
            else if (f.type.includes('string')) value = text(data.readUInt32LE(cursor))
            else if (f.unsigned) value = data.readUIntLE(cursor, f.size)
            else value = data.readIntLE(cursor, f.size)

            values.push(value)
            cursor += f.size
          }

          logicalHash.update(JSON.stringify(values)).update('\n')

          const inserted = insert.run(...values)
          const kind = kinds[name]

          if (kind) {
            const obj = Object.fromEntries(expanded.map((f, i) => [f.name, values[i]]))
            const id = `${kind}:${obj.ID}`
            const label = String(
              obj.Name_lang ??
                obj.MapName_lang ??
                obj.AreaName_lang ??
                obj.DisplayName_lang ??
                obj.Title_lang ??
                obj.Name ??
                obj.ID
            )
            const description = String(obj.Description_lang ?? '')
            const hint = String(obj.NameSubtext_lang ?? '')

            record.run(id, kind, label, table, inserted.lastInsertRowid, description, hint)
            fts.run(id, label, description)
          }
        }

        db.prepare('INSERT INTO meta VALUES (?, ?)').run(`hash.${table}`, logicalHash.digest('hex'))
      }

      for (const name of [...Object.keys(kinds), 'TalentTab'])
        if (!imported.has(name))
          throw new Error(`Missing required Client Data layout or file: ${name}`)

      db.exec(`ALTER TABLE dbc_Talent ADD COLUMN TalentTab_Name_lang TEXT;
      UPDATE dbc_Talent SET TalentTab_Name_lang = COALESCE((SELECT Name_lang FROM dbc_TalentTab WHERE dbc_TalentTab.ID = dbc_Talent.TabID), '');
      UPDATE record SET
        name = COALESCE((SELECT s.Name_lang FROM dbc_Talent t JOIN dbc_Spell s ON s.ID = t.SpellRank_1 WHERE t.rowid = record.source_row), name),
        search_text = COALESCE((SELECT s.Description_lang FROM dbc_Talent t JOIN dbc_Spell s ON s.ID = t.SpellRank_1 WHERE t.rowid = record.source_row), ''),
        hint = COALESCE((SELECT TalentTab_Name_lang FROM dbc_Talent WHERE rowid = record.source_row), '')
      WHERE kind = 'talent';
      DELETE FROM record_fts WHERE id IN (SELECT id FROM record WHERE kind = 'talent');
      INSERT INTO record_fts SELECT id, name, search_text FROM record WHERE kind = 'talent'`)

      const pins = JSON.parse(
        String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value ?? '{}')
      )

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
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
  }
}
