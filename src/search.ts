import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'

interface SearchInput {
  query: string
  kind?: string[]
  limit: number
  offset: number
}

function quoteFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
function literalLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}
function characters(value: string): string[] {
  return value.match(/[\s\S]/gu) ?? []
}

function prepare(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql)
  statement.setAllowUnknownNamedParameters(true)
  return statement
}

export function searchRecords(db: DatabaseSync, input: SearchInput): string {
  const query = input.query.trim()
  const terms = query.split(/\s+/)
  const files = input.kind?.includes('file') ?? false
  if (files && characters(query).length < 3) throw new Error('source search needs ≥ 3 characters')
  const params: Record<string, SQLInputValue> = { query, prefix: `${literalLike(query)}%` }
  let kindFilter = "AND r.kind <> 'file'"
  if (input.kind)
    kindFilter += ` AND r.kind IN (${
      input.kind
        .map((kind, i) => {
          params[`kind${i}`] = kind
          return `$kind${i}`
        })
        .join(',') || 'NULL'
    })`
  let priority = 'r.id = $query'
  if (/^\d+$/.test(query)) priority = "substr(r.id, instr(r.id, ':') + 1) = $query"
  const short = characters(query).length < 3
  const termTests = terms.map((term, i) => {
    params[`term${i}`] = term
    return `instr(lower(r.name), lower($term${i})) > 0`
  })
  const nameTerms = termTests.join(' AND ')
  const allTerms = terms
    .map((_, i) => `(${termTests[i]} OR instr(lower(r.search_text), lower($term${i})) > 0)`)
    .join(' AND ')
  const [longest] = terms
    .filter((term) => characters(term).length >= 3)
    .toSorted((a, b) => b.length - a.length)
  let candidate = ''
  if (!short && longest) {
    params.fts = quoteFts(longest)
    candidate = `AND (r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) OR ${priority})`
  }
  let match = `(${allTerms})`
  if (short) match = "r.name LIKE $prefix ESCAPE '\\'"
  const tier = `CASE WHEN ${priority} THEN 0 WHEN lower(r.name) = lower($query) THEN 1 WHEN r.name LIKE $prefix ESCAPE '\\' THEN 2 WHEN ${nameTerms} THEN 3 ELSE 4 END`
  const normal = `SELECT r.id, r.kind, r.name, r.search_text, r.hint, ${tier} AS tier, 0 AS line FROM record r WHERE (${priority} OR ${match}) ${kindFilter} ${candidate}`
  const lineTests = terms.map((_, i) => `instr(lower(text), lower($term${i})) > 0`).join(' AND ')
  let lineCandidate = ''
  if (longest) lineCandidate = 'AND ui_line_fts MATCH $fts'
  const source = `SELECT 'file:' || path AS id, 'file' AS kind, path AS name, text AS search_text, '' AS hint, 5 AS tier, CAST(line AS INTEGER) AS line FROM ui_line_fts WHERE ${lineTests} ${lineCandidate}`
  let sql = normal
  if (files) sql += ` UNION ALL ${source}`
  let fuzzy = false
  let count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(params)?.total)
  if (count === 0 && characters(query).length >= 4 && !files) {
    const chars = characters(query.toLowerCase())
    const trigrams = [...new Set(chars.slice(0, -2).map((_, i) => chars.slice(i, i + 3).join('')))]
    const fuzzyParams: Record<string, SQLInputValue> = { fts: trigrams.map(quoteFts).join(' OR ') }
    if (input.kind)
      input.kind.forEach((kind, i) => {
        fuzzyParams[`kind${i}`] = kind
      })
    const score = trigrams
      .map((tri, i) => {
        fuzzyParams[`tri${i}`] = tri
        return `(instr(lower(r.name), $tri${i}) > 0)`
      })
      .join(' + ')
    sql = `SELECT r.id, r.kind, r.name, r.search_text, r.hint, 0 AS tier, 0 AS line, (${score}) AS score FROM record r WHERE r.id IN (SELECT id FROM record_fts WHERE record_fts MATCH $fts) ${kindFilter} AND (${score}) > 0`
    count = Number(prepare(db, `SELECT count(*) AS total FROM (${sql})`).get(fuzzyParams)?.total)
    Object.keys(params).forEach((key) => {
      delete params[key]
    })
    Object.assign(params, fuzzyParams)
    fuzzy = true
  }
  params.limit = input.limit
  params.offset = input.offset
  let order =
    'tier, CASE WHEN tier = 5 THEN name END, CASE WHEN tier = 5 THEN line END, length(name), kind, id'
  if (fuzzy) order = 'score DESC, length(name), kind, id'
  const rows = prepare(
    db,
    `SELECT * FROM (${sql}) ORDER BY ${order} LIMIT $limit OFFSET $offset`
  ).all(params)
  const lines = rows.map((row) => {
    const id = String(row.id)
    if (row.kind === 'file')
      return `${id}:${String(row.line)} — ${String(row.search_text).replace(/\s+/g, ' ').trim().slice(0, 160)}`
    const name = String(row.name)
    let detailValue = row.hint
    if (row.tier === 4) detailValue = row.search_text
    const detail = String(detailValue).replace(/\s+/g, ' ').trim()
    let line = id
    if (id.slice(id.indexOf(':') + 1) !== name) line += ` ${name}`
    if (detail) line += ` — ${detail.slice(0, 160)}`
    return line
  })
  let start = 0
  let end = 0
  if (rows.length) {
    start = input.offset + 1
    end = input.offset + rows.length
  }
  const next = input.offset + rows.length
  let footer = `${start}–${end} of ${count}; `
  if (fuzzy) footer = `Fuzzy: ${footer}`
  if (next < count) footer += `next offset: ${next}`
  else footer += 'end'
  lines.push(footer)
  return lines.join('\n')
}
