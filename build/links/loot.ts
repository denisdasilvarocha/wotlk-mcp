import { linkWriter, type AddLink } from './insert.ts'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import type { Database } from '../../src/database.ts'

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

type LootEntries = ReadonlyMap<number, readonly Readonly<Row>[]>

interface LootContext {
  readonly addLink: AddLink
  readonly db: Database
  readonly conditions: Readonly<ReadonlySet<string>>
  readonly records: Readonly<ReadonlySet<string>>
  readonly refs: LootEntries
}

function loadTables(db: Database): Map<string, Map<number, Row[]>> {
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
      .iterate()) {
      const row: Row = {
        Chance: Number(raw.Chance),
        Entry: Number(raw.Entry),
        GroupId: Number(raw.GroupId),
        Item: Number(raw.Item),
        LootMode: Number(raw.LootMode),
        MaxCount: Number(raw.MaxCount),
        MinCount: Number(raw.MinCount),
        QuestRequired: Number(raw.QuestRequired),
        Reference: Number(raw.Reference)
      }
      const list = entries.get(row.Entry) ?? []

      list.push(row)
      entries.set(row.Entry, list)
    }

    tables.set(table, entries)
  }
  return tables
}

function describe(
  row: Readonly<Row>,
  table: string,
  type: number,
  conditions: Readonly<ReadonlySet<string>>
): string {
  let condition = ''

  if (conditions.has(`${type}:${row.Entry}:${row.Item}`)) {
    condition = '; conditions in world_conditions'
  }

  return `world_${table}_loot_template entry ${row.Entry} item ${row.Item}: chance ${row.Chance}%; group ${row.GroupId}; quest required ${row.QuestRequired}; loot mode ${row.LootMode}; count ${row.MinCount}-${row.MaxCount}${condition}`
}

function referenceRows(
  context: Readonly<LootContext>,
  table: string,
  type: number,
  row: Readonly<Row>,
  path: Iterable<number>,
  id: number
): readonly Readonly<Row>[] {
  const next = context.refs.get(id)

  if (!next) {
    const note = describe(row, table, type, context.conditions)
    throw new Error(
      `${note}: missing reference ref:${id} (stored ${row.Reference}); path ${Array.from(path, (n) => `ref:${n}`).join(' -> ') || 'root'}`
    )
  }
  return next
}

function validateReferences(
  context: Readonly<LootContext>,
  tables: ReadonlyMap<string, LootEntries>
): void {
  const active = new Set<number>()
  const validated = new Set<number>()

  function validateEntry(id: number, rows: readonly Readonly<Row>[]): void {
    active.add(id)
    for (const row of rows) {
      if (!row.Reference) {
        continue
      }
      const target = Math.abs(row.Reference)
      if (active.has(target)) {
        const note = describe(row, 'reference', 10, context.conditions)
        throw new Error(
          `${note}: cyclic reference ${[...active, target].map((n) => `ref:${n}`).join(' -> ')}`
        )
      }
      if (!validated.has(target)) {
        validateEntry(target, referenceRows(context, 'reference', 10, row, active, target))
      }
    }
    active.delete(id)
    validated.add(id)
  }

  for (const [id, rows] of context.refs) {
    if (!validated.has(id)) {
      validateEntry(id, rows)
    }
  }

  for (const [, table, , type] of sources) {
    for (const rows of tables.get(table)?.values() ?? []) {
      for (const row of rows) {
        if (row.Reference) {
          referenceRows(context, table, type, row, active, Math.abs(row.Reference))
        }
      }
    }
  }
}

function visit(
  context: Readonly<LootContext>,
  source: string,
  table: string,
  type: number,
  row: Readonly<Row>,
  path: readonly number[],
  evidence: readonly string[]
): void {
  const note = describe(row, table, type, context.conditions)

  if (row.Reference) {
    const id = Math.abs(row.Reference)
    const next = referenceRows(context, table, type, row, path, id)

    for (const child of next) {
      visit(context, source, 'reference', 10, child, [...path, id], [...evidence, note])
    }
  } else {
    if (!context.records.has(`item:${row.Item}`)) {
      throw new Error(`${note}: missing item:${row.Item} Record`)
    }

    let via = ''

    if (path.length > 0) {
      via = ` via ${path.map((n) => `ref:${n}`).join(' -> ')}`
    }
    context.addLink(source, 'drops', `item:${row.Item}`, `${[...evidence, note].join(' | ')}${via}`)
  }
}

function linkOwners(
  context: Readonly<LootContext>,
  tables: ReadonlyMap<string, LootEntries>
): void {
  for (const [kind, table, key, type] of sources) {
    let filter = ''

    if (kind === 'gameobject') {
      filter = 'WHERE type IN (3, 25)'
    }

    const owners = context.db
      .prepare(`SELECT entry, ${key} AS loot FROM world_${kind}_template ${filter} ORDER BY entry`)
      .iterate()
    const entries = tables.get(table)

    if (!entries) {
      throw new Error(`Missing ${table} loot table`)
    }

    for (const owner of owners) {
      const source = `${kind}:${String(owner.entry)}`

      if (!context.records.has(source)) {
        continue
      }

      for (const row of entries.get(Number(owner.loot)) ?? []) {
        visit(context, source, table, type, row, [], [])
      }
    }
  }
}

export function buildLootLinks(file: string): void {
  if (!existsSync(file)) {
    throw new Error(`Database does not exist: ${file}`)
  }

  const db = new DatabaseSync(file)
  db.exec('BEGIN')

  try {
    const conditions = new Set<string>()
    for (const row of db
      .prepare('SELECT SourceTypeOrReferenceId, SourceGroup, SourceEntry FROM world_conditions')
      .iterate()) {
      conditions.add(
        `${String(row.SourceTypeOrReferenceId)}:${String(row.SourceGroup)}:${String(row.SourceEntry)}`
      )
    }
    const records = new Set<string>()
    for (const row of db
      .prepare("SELECT id FROM record WHERE kind IN ('item','creature','gameobject')")
      .iterate()) {
      records.add(String(row.id))
    }
    const tables = loadTables(db)
    const refs = tables.get('reference')

    if (!refs) {
      throw new Error('Missing reference loot table')
    }

    const context = { addLink: linkWriter(db), conditions, db, records, refs }
    validateReferences(context, tables)
    linkOwners(context, tables)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
