import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { addLink } from './links.ts'

export function buildLootLinks(file: string): void {
  if (!existsSync(file)) throw new Error(`Database does not exist: ${file}`)

  const db = new DatabaseSync(file)
  const sources = [
    ['creature', 'creature', 'lootid', 1],
    ['creature', 'skinning', 'skinloot', 11],
    ['creature', 'pickpocketing', 'pickpocketloot', 8],
    ['gameobject', 'gameobject', 'Data1', 4],
    ['item', 'item', 'entry', 5]
  ] as const

  interface Row {
    Entry: number
    Item: number
    Reference: number
    Chance: number
    QuestRequired: number
    LootMode: number
    GroupId: number
    MinCount: number
    MaxCount: number
  }

  db.exec('BEGIN')

  try {
    const conditions = new Set(
      db
        .prepare('SELECT SourceTypeOrReferenceId, SourceGroup, SourceEntry FROM world_conditions')
        .all()
        .map(
          (r) =>
            `${String(r.SourceTypeOrReferenceId)}:${String(r.SourceGroup)}:${String(r.SourceEntry)}`
        )
    )
    const records = new Set(
      db
        .prepare("SELECT id FROM record WHERE kind IN ('item','creature','gameobject')")
        .all()
        .map((r) => String(r.id))
    )
    const tables = new Map<string, Map<number, Row[]>>()

    for (const table of [
      'creature',
      'skinning',
      'pickpocketing',
      'gameobject',
      'item',
      'reference'
    ]) {
      const entries = new Map<number, Row[]>()

      for (const raw of db
        .prepare(
          `SELECT Entry, Item, Reference, Chance, QuestRequired, LootMode, GroupId, MinCount, MaxCount FROM world_${table}_loot_template ORDER BY Entry, Item, Reference`
        )
        .all()) {
        const row: Row = {
          Entry: Number(raw.Entry),
          Item: Number(raw.Item),
          Reference: Number(raw.Reference),
          Chance: Number(raw.Chance),
          QuestRequired: Number(raw.QuestRequired),
          LootMode: Number(raw.LootMode),
          GroupId: Number(raw.GroupId),
          MinCount: Number(raw.MinCount),
          MaxCount: Number(raw.MaxCount)
        }
        const list = entries.get(row.Entry) ?? []

        list.push(row)
        entries.set(row.Entry, list)
      }

      tables.set(table, entries)
    }

    const refs = tables.get('reference')

    if (!refs) throw new Error('Missing reference loot table')

    function describe(row: Row, table: string, type: number): string {
      let condition = ''

      if (conditions.has(`${type}:${row.Entry}:${row.Item}`))
        condition = '; conditions in world_conditions'

      return `world_${table}_loot_template entry ${row.Entry} item ${row.Item}: chance ${row.Chance}%; group ${row.GroupId}; quest required ${row.QuestRequired}; loot mode ${row.LootMode}; count ${row.MinCount}-${row.MaxCount}${condition}`
    }

    function visit(
      source: string,
      table: string,
      type: number,
      row: Row,
      path: number[],
      evidence: string[]
    ): void {
      const note = describe(row, table, type)

      if (row.Reference) {
        const id = Math.abs(row.Reference)
        const next = refs?.get(id)

        if (!next)
          throw new Error(
            `${note}: missing reference ref:${id} (stored ${row.Reference}); path ${path.map((n) => `ref:${n}`).join(' -> ') || 'root'}`
          )
        if (path.includes(id))
          throw new Error(
            `${note}: cyclic reference ${[...path, id].map((n) => `ref:${n}`).join(' -> ')}`
          )

        for (const child of next)
          visit(source, 'reference', 10, child, [...path, id], [...evidence, note])
      } else {
        if (!records.has(`item:${row.Item}`))
          throw new Error(`${note}: missing item:${row.Item} Record`)

        let via = ''

        if (path.length) via = ` via ${path.map((n) => `ref:${n}`).join(' -> ')}`
        addLink(db, source, 'drops', `item:${row.Item}`, `${[...evidence, note].join(' | ')}${via}`)
      }
    }

    for (const [kind, table, key, type] of sources) {
      let filter = ''

      if (kind === 'gameobject') filter = 'WHERE type IN (3, 25)'

      const owners = db
        .prepare(
          `SELECT entry, ${key} AS loot FROM world_${kind}_template ${filter} ORDER BY entry`
        )
        .all()
      const entries = tables.get(table)

      if (!entries) throw new Error(`Missing ${table} loot table`)

      for (const owner of owners) {
        const source = `${kind}:${String(owner.entry)}`

        if (!records.has(source)) continue

        for (const row of entries.get(Number(owner.loot)) ?? [])
          visit(source, table, type, row, [], [])
      }
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
