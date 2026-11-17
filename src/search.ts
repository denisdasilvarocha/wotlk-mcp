import type { Database } from './database.js'
import type { StatementSync } from 'node:sqlite'

interface SearchInput {
  query: string
  kind?: readonly string[]
  limit: number
  offset: number
}

function quoteFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function literalLike(value: string): string {
  return value.replaceAll(/[\\%_]/gu, '\\$&')
}

function characters(value: string): string[] {
  return value.match(/[\s\S]/gu) ?? []
}

function prepare(db: Database, sql: string): StatementSync {
  const statement = db.prepare(sql)

  statement.setAllowUnknownNamedParameters(true)

  return statement
}

function searchSetup(input: Readonly<SearchInput>): {
  files: boolean
  kindFilter: string
  params: Record<string, string | number>
  priority: string
  query: string
  terms: string[]
} {
  const query = input.query.trim()
  const terms = query.split(/\s+/u)
  const files = input.kind?.includes('file') ?? false

  if (files && characters(query).length < 3) {
    throw new Error('source search needs ≥ 3 characters')
  }

  let kindFilter = ''
  const params: Record<string, string | number> = { prefix: `${literalLike(query)}%`, query }

  if (!files) {
    kindFilter = "AND r.kind <> 'file'"
  }

  if (input.kind) {
    kindFilter += ` AND r.kind IN (${
      input.kind
        .map((kind, i) => {
          params[`kind${i}`] = kind
          return `$kind${i}`
        })
        .join(',') || 'NULL'
    })`
  }

  let priority = 'r.id = $query'

  if (/^\d+$/u.test(query)) {
    priority = "substr(r.id, instr(r.id, ':') + 1) = $query"
  }
  return { files, kindFilter, params, priority, query, terms }
}

function searchSql(
  files: boolean,
  kindFilter: string,
  setParam: (key: string, value: string) => void,
  priority: string,
  query: string,
  terms: readonly string[]
): string {
  let candidate = ''
  const short = characters(query).length < 3
  const termTests = terms.map((term, i) => {
    setParam(`term${i}`, term)
    return `instr(lower(r.name), lower($term${i})) > 0`
  })
  const nameTerms = termTests.join(' AND ')
  const allTerms = terms
    .map((_, i) => `(${termTests[i]} OR instr(lower(r.search_text), lower($term${i})) > 0)`)
    .join(' AND ')
  const [longest] = terms
    .filter((term) => characters(term).length >= 3)
    .toSorted((a, b) => b.length - a.length)

  if (!short && longest) {
    setParam('fts', quoteFts(longest))
    candidate = `AND (r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) OR ${priority})`
  }

  let match = `(${allTerms})`

  if (short) {
    match = "r.name LIKE $prefix ESCAPE '\\'"
  }

  let lineCandidate = ''
  const lineTests = terms.map((_, i) => `instr(lower(text), lower($term${i})) > 0`).join(' AND ')
  const tier = `CASE WHEN ${priority} THEN 0 WHEN lower(r.name) = lower($query) THEN 1 WHEN r.name LIKE $prefix ESCAPE '\\' THEN 2 WHEN ${nameTerms} THEN 3 ELSE 4 END`
  const normal = `SELECT r.id, r.kind, r.name, r.search_text, r.hint, ${tier} AS tier, 0 AS line FROM record r WHERE (${priority} OR ${match}) ${kindFilter} ${candidate}`

  if (longest) {
    lineCandidate = 'AND ui_line_fts MATCH $fts'
  }

  const source = `SELECT 'file:' || path AS id, 'file' AS kind, path AS name, text AS search_text, '' AS hint, 5 AS tier, CAST(line AS INTEGER) AS line FROM ui_line_fts WHERE ${lineTests} ${lineCandidate}`
  let sql = normal

  if (files) {
    sql += ` UNION ALL ${source}`
  }
  return sql
}

function fuzzySql(
  query: string,
  kindFilter: string,
  kinds: readonly string[] | undefined
): {
  params: Record<string, string | number>
  sql: string
} {
  const chars = characters(query.toLowerCase())
  const trigrams = [...new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')))]
  const params: Record<string, string | number> = {
    fts: trigrams.map((tri) => quoteFts(tri)).join(' OR ')
  }

  if (kinds) {
    kinds.forEach((kind, i) => {
      params[`kind${i}`] = kind
    })
  }

  const score = trigrams
    .map((tri, i) => {
      params[`tri${i}`] = tri
      return `(instr(lower(r.name), $tri${i}) > 0)`
    })
    .join(' + ')
  const sql = `SELECT r.id, r.kind, r.name, r.search_text, r.hint, 0 AS tier, 0 AS line, (${score}) AS score FROM record r WHERE r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) ${kindFilter} AND (${score}) > 0`

  return { params, sql }
}

function formatRow(row: Readonly<Record<string, unknown>>, terms: readonly string[]): string {
  const id = String(row.id)

  if (row.kind === 'file' && Number(row.line) > 0) {
    return `${id}:${String(row.line)} — ${String(row.search_text).replaceAll(/\s+/gu, ' ').trim().slice(0, 160)}`
  }

  let detailValue = row.hint
  const name = String(row.name)

  if (row.tier === 4) {
    detailValue = row.search_text
  }

  const detail = String(detailValue).replaceAll(/\s+/gu, ' ').trim()
  let line = id

  if (id.slice(id.indexOf(':') + 1) !== name) {
    line += ` ${name}`
  }

  if (detail) {
    let position = 0

    if (row.tier === 4) {
      position =
        terms
          .map((term) => detail.toLowerCase().indexOf(term.toLowerCase()))
          .find((index) => index >= 0) ?? 0
    }

    const start = Math.max(0, position - 40)

    line += ` — ${detail.slice(start, start + 160)}`
  }

  return line
}

function searchFooter(offset: number, length: number, count: number, fuzzy: boolean): string {
  let start = 0
  let end = 0

  if (length > 0) {
    start = offset + 1
    end = offset + length
  }

  let footer = `${start}–${end} of ${count}; `
  const next = offset + length

  if (fuzzy) {
    footer = `Fuzzy: ${footer}`
  }

  if (next < count) {
    footer += `next offset: ${next}`
  } else {
    footer += 'end'
  }

  return footer
}

export function searchRecords(db: Database, input: Readonly<SearchInput>): string {
  const setup = searchSetup(input)
  const { files, kindFilter, priority, query, terms } = setup
  let { params } = setup
  let sql = searchSql(
    files,
    kindFilter,
    (key, value) => {
      params[key] = value
    },
    priority,
    query,
    terms
  )

  let count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  let fuzzy = false

  if (count === 0 && characters(query).length >= 4 && !files) {
    const result = fuzzySql(query, kindFilter, input.kind)
    sql = result.sql
    params = result.params
    count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
    fuzzy = true
  }

  params.limit = input.limit
  params.offset = input.offset

  let order =
    'tier, CASE WHEN tier = 5 THEN name END, CASE WHEN tier = 5 THEN line END, length(name), kind, id'

  if (fuzzy) {
    order = 'score DESC, length(name), kind, id'
  }

  const rows = prepare(
    db,
    `SELECT * FROM (${sql}) ORDER BY ${order} LIMIT $limit OFFSET $offset`
  ).all(params)
  const lines = rows.map((row: Readonly<Record<string, unknown>>) => formatRow(row, terms))
  lines.push(searchFooter(input.offset, rows.length, count, fuzzy))

  return lines.join('\n')
}
