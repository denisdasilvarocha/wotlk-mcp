import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'

type TextRows = {
  readonly statement: StatementSync
  readonly decodeRow?: (row: SQLOutputValue[]) => void
}

export function prepareTextRows(
  db: Readonly<DatabaseSync>,
  statement: StatementSync,
  sql: string,
  columnCount: number
): TextRows {
  if (!/^(?:SELECT|VALUES|WITH)\b/iu.test(sql)) {
    return { statement }
  }

  const probe = db.prepare('SELECT char(97,0,98) AS text, hex(char(233)) AS encoding').get()

  if (probe?.text === 'a\0b') {
    return { statement }
  }

  let encoding = 'utf-8'

  if (probe?.encoding === 'E900') {
    encoding = 'utf-16le'
  } else if (probe?.encoding === '00E9') {
    encoding = 'utf-16be'
  }

  const decoder = new TextDecoder(encoding, { ignoreBOM: true })
  const sourceName = unusedSourceName(sql)
  const columns = Array.from({ length: columnCount }, (_, index) => `c${index}`)
  const projection = columns.map(encodeText).join(', ')
  const wrapped = db.prepare(`
    WITH ${sourceName}(${columns.join(', ')}) AS (
      ${sql}
    )
    SELECT ${projection} FROM (SELECT * FROM ${sourceName} LIMIT -1 OFFSET 0)
  `)

  return {
    decodeRow(row) {
      for (const [index, value] of row.entries()) {
        if (typeof value === 'string' && value.startsWith('~')) {
          row[index] = value.startsWith('~~')
            ? value.slice(1)
            : decoder.decode(Buffer.from(value.slice(1), 'hex'))
        }
      }
    },
    statement: wrapped
  }
}

function unusedSourceName(sql: string): string {
  const lowerSql = sql.toLowerCase()
  let index = 0
  let name = `_wotlk_text_rows_${index}`

  while (lowerSql.includes(name)) {
    index++
    name = `_wotlk_text_rows_${index}`
  }

  return name
}

function encodeText(column: string): string {
  return `CASE WHEN typeof(${column}) <> 'text' THEN ${column}
    WHEN instr(${column}, char(0)) > 0 THEN '~' || hex(${column})
    WHEN substr(${column}, 1, 1) = '~' THEN '~' || ${column}
    ELSE ${column} END`
}
