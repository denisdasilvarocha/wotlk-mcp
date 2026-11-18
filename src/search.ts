import type { Database } from './database.js'
import type { StatementSync } from 'node:sqlite'

interface SearchInput {
  query: string
  kind?: readonly string[]
  limit: number
  offset: number
}

type Params = Record<string, string | number>

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

  return longest
}

function registerLiteralMatch(db: Database, query: string, terms: readonly RegExp[]): void {
  const patterns = [literalPattern(query, 'exact'), literalPattern(query, 'prefix'), ...terms]
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

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
  const priority = /^\d+$/u.test(query)
    ? "substr(r.id, instr(r.id, ':') + 1) = $query"
    : 'r.id = $query'
  const name = 'CAST(r.name AS BLOB)'
  const nameTests = terms.map((_, i) => `literal_match(${name}, ${i + 2})`)
  const longest = indexedLiteral(terms)
  let candidate = ''
  let lineCandidate = ''

  if (longest) {
    params.fts = quoteFts(longest)
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
  const trigrams = [...new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')))]
  const params: Params = { ...kindParams, fts: trigrams.map((tri) => quoteFts(tri)).join(' OR ') }
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

export function searchRecords(db: Database, input: Readonly<SearchInput>): string {
  const { query } = input
  const terms = query.split(/\s+/u)
  const files = input.kind?.includes('file') ?? false

  if (files && characters(query).length < 3) {
    throw new Error('source search needs ≥ 3 characters')
  }

  const kindParams: Params = {}
  let kindFilter = files ? '' : "AND r.kind <> 'file'"

  if (input.kind) {
    kindFilter += ` AND r.kind IN (${
      input.kind
        .map((kind, i) => {
          kindParams[`kind${i}`] = kind
          return `$kind${i}`
        })
        .join(',') || 'NULL'
    })`
  }

  const patterns = terms.map((term) => literalPattern(term))

  registerLiteralMatch(db, query, patterns)

  let { params, sql } = matchSql(query, terms, files, kindFilter, kindParams)
  let count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  const fuzzy = count === 0 && characters(query).length >= 4 && !files

  if (fuzzy) {
    ;({ params, sql } = fuzzySql(query, kindFilter, kindParams))
    count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  }

  const order = fuzzy
    ? 'score DESC, length(name), kind, id'
    : 'tier, CASE WHEN tier = 5 THEN name END, CASE WHEN tier = 5 THEN line END, length(name), kind, id'
  const rows = prepare(
    db,
    `SELECT * FROM (${sql}) ORDER BY ${order} LIMIT $limit OFFSET $offset`
  ).all({ ...params, limit: input.limit, offset: input.offset })

  return [
    ...rows.map((row) => formatRow(row, patterns)),
    `${fuzzy ? 'Fuzzy: ' : ''}${pageFooter(input.offset, rows.length, count)}`
  ].join('\n')
}
