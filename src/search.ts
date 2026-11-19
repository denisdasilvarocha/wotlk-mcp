import { kinds } from './schema.js'

import type { Database } from './database.js'
import type { StatementSync } from 'node:sqlite'

interface SearchInput {
  query: string
  kind?: readonly string[]
  limit: number
  offset: number
}

type Params = Record<string, string | number>

const maxQueryLength = 4096
const maxTerms = 64
const maxFuzzyTrigrams = 64
const kindPrefix = new RegExp(`^(${kinds.join('|')}):`, 'iu')

function quoteFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function characters(value: string): string[] {
  return value.match(/[\s\S]/gu) ?? []
}

function literalPattern(value: string, match: 'any' | 'prefix' | 'exact' = 'any'): RegExp {
  const start = match === 'any' ? '' : '^'
  const end = match === 'exact' ? '$' : ''

  return new RegExp(`${start}${value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}${end}`, 'iu')
}

function indexedLiteral(terms: readonly string[]): string {
  let longest = ''

  for (const term of terms) {
    for (const part of term.split(/[^!-~]|[KkSs]/u)) {
      if (part.length >= 3 && part.length > longest.length) {
        longest = part
      }
    }
  }

  if (longest) {
    return quoteFts(longest)
  }

  for (const term of terms) {
    const part = term.match(/[!-~]{3}/u)?.[0]
    if (part) {
      let variants = ['']
      for (const character of part.toLowerCase()) {
        const equivalents =
          character === 's' ? ['s', 'ſ'] : character === 'k' ? ['k', 'K'] : [character]
        variants = variants.flatMap((variant) => equivalents.map((value) => variant + value))
      }
      return variants.map(quoteFts).join(' OR ')
    }
  }

  return ''
}

function registerLiteralMatch(db: Database, query: string, terms: readonly RegExp[]): void {
  const patterns = [literalPattern(query, 'exact'), literalPattern(query, 'prefix'), ...terms]
  const encoding = String(db.prepare('PRAGMA encoding').get()?.encoding)
  const decoder = new TextDecoder(encoding, { ignoreBOM: true })

  db.function('literal_match', { deterministic: true, directOnly: true }, (value, pattern) =>
    value instanceof Uint8Array && typeof pattern === 'number'
      ? Number(patterns[pattern]?.test(decoder.decode(value)) ?? false)
      : 0
  )
}

function prepare(db: Database, sql: string): StatementSync {
  const statement = db.prepare(sql)

  statement.setAllowUnknownNamedParameters(true)

  return statement
}

function matchSql(
  query: string,
  terms: readonly string[],
  files: boolean,
  kindFilter: string,
  kindParams: Readonly<Params>
): { params: Params; sql: string } {
  const params: Params = { ...kindParams, query }
  const idKind = kindPrefix.exec(query)?.[1].toLowerCase().replaceAll('ſ', 's')
  if (idKind) {
    params.idKind = idKind
  }
  const priority = /^\d+$/u.test(query)
    ? "substr(r.id, instr(r.id, ':') + 1) = $query"
    : idKind
      ? '(r.kind = $idKind AND literal_match(CAST(r.id AS BLOB), 0))'
      : 'r.id = $query'
  const name = 'CAST(r.name AS BLOB)'
  const nameTests = terms.map((_, i) => `literal_match(${name}, ${i + 2})`)
  const fts = indexedLiteral(terms)
  let candidate = ''
  let lineCandidate = ''

  if (fts) {
    params.fts = fts
    candidate = `AND (r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) OR ${priority})`
    lineCandidate = 'AND ui_line_fts MATCH $fts'
  }

  const prefix = `literal_match(${name}, 1)`
  const match =
    characters(query).length < 3
      ? prefix
      : `(${nameTests.map((test, i) => `(${test} OR literal_match(CAST(r.search_text AS BLOB), ${i + 2}))`).join(' AND ')})`
  const tier = `CASE WHEN ${priority} THEN 0 WHEN literal_match(${name}, 0) THEN 1 WHEN ${prefix} THEN 2 WHEN ${nameTests.join(' AND ')} THEN 3 ELSE 4 END`
  const sql = `SELECT r.id, r.kind, r.name, r.search_text, r.hint, ${tier} AS tier, 0 AS line FROM record r WHERE (${priority} OR ${match}) ${kindFilter} ${candidate}`

  if (!files) {
    return { params, sql }
  }

  const lineTests = terms.map((_, i) => `literal_match(CAST(text AS BLOB), ${i + 2})`).join(' AND ')

  return {
    params,
    sql: `${sql} UNION ALL SELECT 'file:' || path AS id, 'file' AS kind, path AS name, text AS search_text, '' AS hint, 5 AS tier, CAST(line AS INTEGER) AS line FROM ui_line_fts WHERE ${lineTests} ${lineCandidate}`
  }
}

function fuzzySql(
  query: string,
  kindFilter: string,
  kindParams: Readonly<Params>
): { params: Params; sql: string } {
  const chars = characters(query.toLowerCase())
  const distinctTrigrams = new Set<string>()

  for (let i = 0; i + 2 < chars.length && distinctTrigrams.size < maxFuzzyTrigrams; i++) {
    distinctTrigrams.add(chars[i] + chars[i + 1] + chars[i + 2])
  }

  const trigrams = [...distinctTrigrams]
  const params: Params = { ...kindParams, fts: trigrams.map(quoteFts).join(' OR ') }
  const score = trigrams
    .map((tri, i) => {
      params[`tri${i}`] = tri
      return `(instr(lower(r.name), $tri${i}) > 0)`
    })
    .join(' + ')

  return {
    params,
    sql: `SELECT r.id, r.kind, r.name, r.search_text, r.hint, 0 AS tier, 0 AS line, (${score}) AS score FROM record r WHERE r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) ${kindFilter} AND (${score}) > 0`
  }
}

function formatRow(row: Readonly<Record<string, unknown>>, terms: readonly RegExp[]): string {
  const id = String(row.id)

  if (row.kind === 'file' && Number(row.line) > 0) {
    return `${id}:${String(row.line)} — ${String(row.search_text).replaceAll(/\s+/gu, ' ').trim().slice(0, 160)}`
  }

  const name = String(row.name)
  const line = id.slice(id.indexOf(':') + 1) === name ? id : `${id} ${name}`
  const detail = String(row.tier === 4 ? row.search_text : row.hint)
    .replaceAll(/\s+/gu, ' ')
    .trim()

  if (!detail) {
    return line
  }

  const position =
    row.tier === 4
      ? (terms.map((term) => term.exec(detail)?.index).find((index) => index !== undefined) ?? 0)
      : 0
  const start = Math.max(0, position - 40)

  return `${line} — ${detail.slice(start, start + 160)}`
}

export function pageFooter(offset: number, length: number, total: number): string {
  const end = offset + length
  const range = length > 0 ? `${offset + 1}–${end}` : '0–0'

  return `${range} of ${total}; ${end < total ? `next offset: ${end}` : 'end'}`
}

function validatedTerms(query: string): string[] {
  if (query.length > maxQueryLength) {
    throw new Error(`Search query needs at most ${maxQueryLength} UTF-16 code units`)
  }

  if (query.includes('\0')) {
    throw new Error('Search query must not contain NUL')
  }

  const terms: string[] = []
  const patterns: RegExp[] = []

  for (const term of new Set(query.split(/\s+/u))) {
    if (patterns.some((pattern) => pattern.test(term))) {
      continue
    }

    if (terms.length === maxTerms) {
      throw new Error(`Search query needs at most ${maxTerms} distinct terms`)
    }

    terms.push(term)
    patterns.push(literalPattern(term, 'exact'))
  }

  return terms
}

export function validateSearch(input: Readonly<SearchInput>): string[] {
  const terms = validatedTerms(input.query)
  if (input.kind?.includes('file') && characters(input.query).length < 3) {
    throw new Error('source search needs ≥ 3 characters')
  }
  return terms
}

export function searchRecords(
  db: Database,
  input: Readonly<SearchInput>,
  terms: readonly string[]
): string {
  const { query } = input
  const files = input.kind?.includes('file') ?? false

  const kindParams: Params = {}
  let kindFilter = files ? '' : "AND r.kind <> 'file'"

  if (input.kind) {
    const selectedKinds = [...new Set(input.kind)]
      .map((kind, i) => {
        kindParams[`kind${i}`] = kind
        return `$kind${i}`
      })
      .join(',')
    kindFilter += ` AND r.kind IN (${selectedKinds || 'NULL'})`
  }

  const patterns = terms.map((term) => literalPattern(term))

  registerLiteralMatch(db, query, patterns)

  let { params, sql } = matchSql(query, terms, files, kindFilter, kindParams)
  let count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  const recordKinds = !files || input.kind?.some((kind) => kind !== 'file')
  const fuzzy = count === 0 && characters(query).length >= 4 && recordKinds

  if (fuzzy) {
    const recordFilter = files ? `${kindFilter} AND r.kind <> 'file'` : kindFilter
    const fallback = fuzzySql(query, recordFilter, kindParams)
    params = fallback.params
    sql = fallback.sql
    count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  }

  const order = fuzzy
    ? 'score DESC, length(name), kind, id'
    : 'tier, CASE WHEN tier = 0 AND id = $query THEN 0 ELSE 1 END, CASE WHEN tier = 5 THEN name END, CASE WHEN tier = 5 THEN line END, length(name), kind, id'
  const rows = prepare(
    db,
    `SELECT * FROM (${sql}) ORDER BY ${order} LIMIT $limit OFFSET $offset`
  ).all({ ...params, limit: input.limit, offset: input.offset })

  return [
    ...rows.map((row) => formatRow(row, patterns)),
    `${fuzzy ? 'Fuzzy: ' : ''}${pageFooter(input.offset, rows.length, count)}`
  ].join('\n')
}
