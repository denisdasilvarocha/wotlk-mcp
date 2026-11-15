import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import { parseEnum } from './enum-parser.ts'

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function importSpellEnums(database: string, sourceDirectory: string): void {
  const headers = [
    'src/server/shared/SharedDefines.h',
    'src/server/game/Spells/Auras/SpellAuraDefines.h',
    'src/server/game/Spells/SpellDefines.h',
    'src/server/game/Spells/SpellInfo.h',
    'src/server/game/Spells/SpellMgr.h'
  ].map((name) => readFileSync(path.join(sourceDirectory, name), 'utf8'))
  const mappingSchema = z.object({
    field: z.string().regex(/^\w+$/),
    name: z.string().regex(/^\w+$/),
    flags: z.boolean()
  })
  const mappings = [
    ...[
      'Attributes',
      'AttributesEx',
      'AttributesExB',
      'AttributesExC',
      'AttributesExD',
      'AttributesExE',
      'AttributesExF',
      'AttributesExG'
    ].map((field, index) => ({ field, name: `SpellAttr${index}`, flags: true })),
    ...[
      ['Targets', 'SpellCastTargetFlags', true],
      ['TargetCreatureType', 'CreatureTypeMask', true],
      ['InterruptFlags', 'SpellInterruptFlags', true],
      ['AuraInterruptFlags', 'SpellAuraInterruptFlags', true],
      ['ChannelInterruptFlags', 'SpellChannelInterruptFlags', true],
      ['ProcTypeMask', 'ProcFlags', true],
      ['PowerType', 'Powers', false],
      ['SchoolMask', 'SpellSchoolMask', true]
    ].map(([field, name, flags]) => ({ field, name, flags })),
    ...[1, 2, 3].flatMap((i) =>
      [
        ['Effect', 'SpellEffects'],
        ['EffectAura', 'AuraType'],
        ['ImplicitTargetA', 'Targets'],
        ['ImplicitTargetB', 'Targets']
      ].map(([field, name]) => ({ field: `${field}_${i}`, name, flags: false }))
    )
  ].map((mapping) => mappingSchema.parse(mapping))
  const db = new DatabaseSync(database)

  try {
    db.exec('BEGIN IMMEDIATE')

    function columns(table: string): string[] {
      return db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((row) => String(row.name))
    }

    const spellColumns = columns('dbc_Spell')

    for (const mapping of mappings)
      if (!spellColumns.includes(mapping.field))
        throw new Error(`Missing mapped column dbc_Spell.${mapping.field}`)

    const insertValue = db.prepare(
      'INSERT OR IGNORE INTO enum_value (enum_name, value, name) VALUES (?, ?, ?)'
    )
    const insertField = db.prepare(
      'INSERT INTO enum_field (source_table, field, enum_name, flags, condition_field, condition_value) VALUES (?, ?, ?, ?, NULL, NULL)'
    )

    for (const name of new Set(mappings.map((mapping) => mapping.name))) {
      let enumName = name

      if (name === 'CreatureTypeMask') enumName = 'CreatureType'

      const header = headers.find((text) =>
        new RegExp(`\\benum\\s+${enumName}\\b[^;{}]*\\{`).test(text)
      )

      if (!header) throw new Error(`Missing pinned enum ${enumName}`)

      let external: { value: number; name: string }[] = []

      if (name === 'SpellSchoolMask') external = parseEnum(headers[0], 'SpellSchools')

      let entries = parseEnum(header, enumName, external)

      if (name === 'CreatureTypeMask') {
        entries = entries.filter((entry) => entry.value > 0)

        for (const entry of entries) entry.value = 2 ** (entry.value - 1)
      }

      let prefix = entries[0].name

      for (const entry of entries)
        while (!entry.name.startsWith(prefix)) prefix = prefix.slice(0, -1)

      prefix = prefix.slice(0, prefix.lastIndexOf('_') + 1)

      for (const entry of entries)
        insertValue.run(name, entry.value, entry.name.slice(prefix.length) || entry.name)
    }

    for (const mapping of mappings)
      insertField.run('dbc_Spell', mapping.field, mapping.name, Number(mapping.flags))

    const foreignKeys = db
      .prepare(
        'SELECT source_table, field, target_table, target_field FROM dbc_foreign_key ORDER BY source_table, field'
      )
      .all()
    const materialized = new Set<string>()

    for (const key of foreignKeys) {
      const source = String(key.source_table),
        field = String(key.field),
        target = String(key.target_table),
        targetField = String(key.target_field)

      if (!columns(source).includes(field))
        throw new Error(`Missing mapped column ${source}.${field}`)

      const name = `reference.${target}.${targetField}`

      insertField.run(source, field, name, 0)

      if (materialized.has(name)) continue

      materialized.add(name)

      const targetColumns = columns(target)

      if (!targetColumns.includes(targetField)) continue

      const nameColumn =
        targetColumns.find((column) => /^Name_lang$/i.test(column)) ??
        targetColumns.find((column) => column.endsWith('Name_lang')) ??
        targetColumns.find((column) => /^Name$/i.test(column))

      if (!nameColumn) continue

      const rows = db
        .prepare(
          `SELECT ${quote(targetField)} AS id, ${quote(nameColumn)} AS name FROM ${quote(target)}`
        )
        .all()

      for (const row of rows)
        if (typeof row.id === 'number' && typeof row.name === 'string' && row.name)
          insertValue.run(name, row.id, row.name)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
