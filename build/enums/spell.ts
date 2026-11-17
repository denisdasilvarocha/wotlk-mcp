import { quoteIdentifier } from '../shared/table-hash.ts'
import { enumValues, parseEnum } from './parser.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

import type { Database } from '../../src/database.ts'

const mappingSchema = z.object({
  field: z.string().regex(/^\w+$/u),
  flags: z.boolean(),
  name: z.string().regex(/^\w+$/u)
})

function columns(db: Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row: Readonly<Record<string, unknown>>) => String(row.name))
}

function insertSpellValues(
  db: Database,
  headers: readonly string[],
  mappings: readonly Readonly<{ name: string }>[]
): void {
  const insertValue = db.prepare(
    'INSERT OR IGNORE INTO enum_value (enum_name, value, name) VALUES (?, ?, ?)'
  )
  const names = new Set(mappings.map((mapping) => mapping.name))

  for (const name of names) {
    const enumName = name === 'CreatureTypeMask' ? 'CreatureType' : name
    const header = headers.find((text) =>
      new RegExp(`\\benum\\s+${enumName}\\b[^;{}]*\\{`, 'u').test(text)
    )
    if (header === undefined) {
      throw new Error(`Missing pinned enum ${enumName}`)
    }
    const external = name === 'SpellSchoolMask' ? parseEnum(headers[0], 'SpellSchools') : []
    const entries = parseEnum(header, enumName, external)
    for (const entry of enumValues(entries, name === 'CreatureTypeMask')) {
      insertValue.run(name, entry.value, entry.name)
    }
  }
}

function materializeForeignKeys(
  db: Database,
  insertField: Readonly<ReturnType<Database['prepare']>>
): void {
  const insertValue = db.prepare(
    'INSERT OR IGNORE INTO enum_value (enum_name, value, name) VALUES (?, ?, ?)'
  )
  const foreignKeys = db
    .prepare(
      'SELECT source_table, field, target_table, target_field FROM dbc_foreign_key ORDER BY source_table, field'
    )
    .all()
  const materialized = new Set<string>()
  for (const key of foreignKeys) {
    const field = String(key.field),
      source = String(key.source_table),
      target = String(key.target_table),
      targetField = String(key.target_field)
    if (!columns(db, source).includes(field)) {
      throw new Error(`Missing mapped column ${source}.${field}`)
    }
    const name = `reference.${target}.${targetField}`
    insertField.run(source, field, name, 0)
    if (materialized.has(name)) {
      continue
    }
    materialized.add(name)
    materializeTarget(db, target, targetField, name, insertValue)
  }
}

function materializeTarget(
  db: Database,
  target: string,
  targetField: string,
  name: string,
  insertValue: Readonly<ReturnType<Database['prepare']>>
): void {
  const targetColumns = columns(db, target)
  if (!targetColumns.includes(targetField)) {
    return
  }
  const nameColumn =
    targetColumns.find((column) => /^Name_lang$/iu.test(column)) ??
    targetColumns.find((column) => column.endsWith('Name_lang')) ??
    targetColumns.find((column) => /^Name$/iu.test(column))
  if (nameColumn === undefined) {
    return
  }
  const rows = db
    .prepare(
      `SELECT ${quoteIdentifier(targetField)} AS id, ${quoteIdentifier(nameColumn)} AS name FROM ${quoteIdentifier(target)}`
    )
    .all()
  for (const row of rows) {
    if (typeof row.id === 'number' && typeof row.name === 'string' && row.name) {
      insertValue.run(name, row.id, row.name)
    }
  }
}

function spellMappings(): { field: string; flags: boolean; name: string }[] {
  return [
    ...[
      'Attributes',
      'AttributesEx',
      'AttributesExB',
      'AttributesExC',
      'AttributesExD',
      'AttributesExE',
      'AttributesExF',
      'AttributesExG'
    ].map((field, index) => ({ field, flags: true, name: `SpellAttr${index}` })),
    ...(
      [
        ['Targets', 'SpellCastTargetFlags', true],
        ['TargetCreatureType', 'CreatureTypeMask', true],
        ['InterruptFlags', 'SpellInterruptFlags', true],
        ['AuraInterruptFlags', 'SpellAuraInterruptFlags', true],
        ['ChannelInterruptFlags', 'SpellChannelInterruptFlags', true],
        ['ProcTypeMask', 'ProcFlags', true],
        ['PowerType', 'Powers', false],
        ['SchoolMask', 'SpellSchoolMask', true]
      ] as const
    ).map(([field, name, flags]: readonly [string, string, boolean]) => ({
      field,
      flags,
      name
    })),
    ...[1, 2, 3].flatMap((i) =>
      (
        [
          ['Effect', 'SpellEffects'],
          ['EffectAura', 'AuraType'],
          ['ImplicitTargetA', 'Targets'],
          ['ImplicitTargetB', 'Targets']
        ] as const
      ).map(([field, name]: readonly [string, string]) => ({
        field: `${field}_${i}`,
        flags: false,
        name
      }))
    )
  ].map((mapping: Readonly<{ field: string; flags: boolean; name: string }>) =>
    mappingSchema.parse(mapping)
  )
}

export function importSpellEnums(database: string, sourceDirectory: string): void {
  const headers = [
    'src/server/shared/SharedDefines.h',
    'src/server/game/Spells/Auras/SpellAuraDefines.h',
    'src/server/game/Spells/SpellDefines.h',
    'src/server/game/Spells/SpellInfo.h',
    'src/server/game/Spells/SpellMgr.h'
  ].map((name) => readFileSync(path.join(sourceDirectory, name), 'utf8'))
  const mappings = spellMappings()
  const db = new DatabaseSync(database)

  try {
    db.exec('BEGIN IMMEDIATE')

    const spellColumns = columns(db, 'dbc_Spell')

    for (const mapping of mappings) {
      if (!spellColumns.includes(mapping.field)) {
        throw new Error(`Missing mapped column dbc_Spell.${mapping.field}`)
      }
    }

    const insertField = db.prepare(
      'INSERT INTO enum_field (source_table, field, enum_name, flags, condition_field, condition_value) VALUES (?, ?, ?, ?, NULL, NULL)'
    )

    insertSpellValues(db, headers, mappings)

    for (const mapping of mappings) {
      insertField.run('dbc_Spell', mapping.field, mapping.name, Number(mapping.flags))
    }

    materializeForeignKeys(db, insertField)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
