import { sha256Hex } from '../shared/sha256.ts'
import type { Registration, TableDecision } from './registration.ts'
import { sorted } from './widget.ts'

type Widgets = Readonly<
  Pick<Map<string, readonly string[]>, 'get' | 'has' | typeof Symbol.iterator>
>
type Lookups = { readonly widgets: Widgets; readonly parents: Widgets; readonly inherited: Widgets }

function validateInheritance(
  table: string,
  entries: readonly Registration[],
  names: string,
  override: TableDecision,
  lookups: Lookups
): void {
  const { widgets, parents, inherited } = lookups
  const own = widgets.get(override.widget) ?? []
  const inheritedNames = inherited.get(override.widget) ?? []
  const baseNames = (parents.get(override.widget) ?? []).flatMap((name) => widgets.get(name) ?? [])
  const matches = [...widgets].filter(
    ([name, methods]: readonly [string, readonly string[]]) =>
      sorted([...methods, ...(inherited.get(name) ?? [])]) === names
  )
  const remaining = entries
    .map((entry) => entry.name)
    .filter((name) => !inheritedNames.includes(name))
  if (
    matches.length !== 1 ||
    matches[0][0] !== override.widget ||
    sorted(baseNames) !== sorted(inheritedNames) ||
    sorted(remaining) !== sorted(own)
  ) {
    throw new Error(`Invalid inherited widget override: ${table}`)
  }
}

function validateMissing(
  table: string,
  missing: TableDecision,
  widgets: Widgets,
  names: string,
  candidates: readonly string[]
): void {
  if (
    widgets.has(missing.widget) ||
    typeof missing.widget !== 'string' ||
    !missing.widget ||
    typeof missing.methods_sha256 !== 'string' ||
    missing.methods_sha256 !== sha256Hex(names) ||
    typeof missing.reason !== 'string' ||
    !missing.reason.trim() ||
    candidates.length > 0
  ) {
    throw new Error(`Invalid or stale missing widget decision: ${table}`)
  }
}

export function resolveTable(
  table: string,
  entries: readonly Registration[],
  missing: TableDecision | undefined,
  override: TableDecision | undefined,
  lookups: Lookups
): string | undefined {
  const { widgets } = lookups
  const names = sorted(entries.map((entry) => entry.name))
  const candidates = [...widgets]
    .filter(([, methods]: readonly [string, readonly string[]]) => sorted(methods) === names)
    .map(([name]: readonly [string, readonly string[]]) => name)
  if (override && missing) {
    throw new Error(`Conflicting widget decisions: ${table}`)
  }
  if (missing) {
    validateMissing(table, missing, widgets, names, candidates)
    return undefined
  }
  if (!override) {
    if (candidates.length !== 1) {
      throw new Error(
        `Unresolved widget table ${table}: ${candidates.join(', ') || 'no exact match'}`
      )
    }
    return candidates[0]
  }
  if (
    !widgets.has(override.widget) ||
    typeof override.methods_sha256 !== 'string' ||
    override.methods_sha256 !== sha256Hex(names) ||
    typeof override.reason !== 'string' ||
    !override.reason.trim()
  ) {
    throw new Error(`Invalid or stale widget override: ${table}`)
  }
  if (override.exact_inheritance === true) {
    validateInheritance(table, entries, names, override, lookups)
  }
  return override.widget
}
