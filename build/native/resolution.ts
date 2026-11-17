import { resolveTable } from './decision.ts'
import { parseStrings, type Registration, type TableDecision } from './registration.ts'

import type { Database } from '../../src/database.ts'

type Decisions = Readonly<Record<string, TableDecision | undefined>>

function checkUnused(
  tables: Readonly<Pick<Map<string, Registration[]>, 'has'>>,
  overrides: Decisions,
  missingWidgets: Decisions
): void {
  for (const table of Object.keys(overrides)) {
    if (!tables.has(table)) {
      throw new Error(`Unused widget override: ${table}`)
    }
  }
  for (const table of Object.keys(missingWidgets)) {
    if (!tables.has(table)) {
      throw new Error(`Unused missing widget decision: ${table}`)
    }
  }
}

function registrationTables(rows: readonly Registration[]): Map<string, Registration[]> {
  const tables = new Map<string, Registration[]>()
  for (const row of rows) {
    if (row.kind !== 'method') {
      continue
    }
    if (!tables.has(row.table)) {
      tables.set(row.table, [])
    }
    tables.get(row.table)?.push(row)
  }
  return tables
}

export function resolveWidgets(
  db: Database,
  rows: readonly Registration[],
  missingWidgets: Decisions,
  overrides: Decisions
): {
  widgets: Map<string, readonly string[]>
  parents: Map<string, readonly string[]>
  inherited: Map<string, readonly string[]>
  resolved: Map<string, string>
} {
  const widgetRows = db
    .prepare('SELECT name, methods, inherits, inheritedMethods FROM lua_widget')
    .all()
  const widgets = new Map<string, readonly string[]>()
  const parents = new Map<string, readonly string[]>()
  const inherited = new Map<string, readonly string[]>()

  for (const row of widgetRows) {
    const name = String(row.name)

    widgets.set(name, parseStrings(String(row.methods)))
    parents.set(name, parseStrings(String(row.inherits)))
    inherited.set(name, parseStrings(String(row.inheritedMethods)))
  }

  const tables = registrationTables(rows)

  const resolved = new Map<string, string>()

  for (const [table, entries] of tables) {
    const widget = resolveTable(table, entries, missingWidgets[table], overrides[table], {
      inherited,
      parents,
      widgets
    })
    if (widget !== undefined) {
      resolved.set(table, widget)
    }
  }

  checkUnused(tables, overrides, missingWidgets)
  return { inherited, parents, resolved, widgets }
}
