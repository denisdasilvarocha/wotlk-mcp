export interface Registration {
  readonly kind: string
  readonly name: string
  readonly va: string
  readonly context: string
  readonly table: string
  readonly index: number
  readonly call_sites: readonly string[]
}

export interface TableDecision {
  readonly widget: string
  readonly methods_sha256: string
  readonly reason: string
  readonly exact_inheritance?: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseStrings(text: string): readonly string[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    throw new Error('Invalid widget methods')
  }
  return value
}

export function isRegistration(value: unknown): value is Registration {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    typeof value.name === 'string' &&
    typeof value.va === 'string' &&
    typeof value.context === 'string' &&
    typeof value.table === 'string' &&
    typeof value.index === 'number' &&
    Array.isArray(value.call_sites) &&
    value.call_sites.every((site: unknown) => typeof site === 'string')
  )
}

export function isDecision(value: unknown): value is TableDecision {
  return (
    isRecord(value) &&
    typeof value.widget === 'string' &&
    typeof value.methods_sha256 === 'string' &&
    typeof value.reason === 'string' &&
    (value.exact_inheritance === undefined || typeof value.exact_inheritance === 'boolean')
  )
}

export function parseDecisions(value: unknown): Record<string, TableDecision | undefined> {
  if (!isRecord(value)) {
    throw new Error('Invalid widget decisions')
  }
  const decisions: Record<string, TableDecision | undefined> = {}
  for (const [key, decision] of Object.entries(value)) {
    if (!isDecision(decision)) {
      throw new Error('Invalid widget decisions')
    }
    decisions[key] = decision
  }
  return decisions
}

export function validateRegistrations(rows: readonly Registration[]): void {
  const address = /^0x[0-9A-F]{8}$/u

  for (const row of rows) {
    if (
      !['global', 'method'].includes(row.kind) ||
      typeof row.name !== 'string' ||
      !row.name ||
      !address.test(row.va) ||
      !address.test(row.table) ||
      !['game', 'glue'].includes(row.context) ||
      !Number.isSafeInteger(row.index) ||
      row.index < 0 ||
      !Array.isArray(row.call_sites) ||
      row.call_sites.length === 0 ||
      !row.call_sites.every((site: string) => address.test(site))
    ) {
      throw new Error('Invalid native registration row')
    }
  }
}
