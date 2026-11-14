import { DatabaseSync, constants } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'

const maxOutput = 32000
const pragmas = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'foreign_key_list'
])
const actions = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE
])

function escape(value: SQLOutputValue, header = false): string {
  if (value === null) return 'NULL'
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`
  const text = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  if (!header && text === 'NULL') return '\\NULL'
  return text
}

function execute(path: string, query: string, limit: number): string {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try {
    db.setAuthorizer((action, arg1) => {
      if (actions.has(action)) return constants.SQLITE_OK
      if (action === constants.SQLITE_PRAGMA && pragmas.has((arg1 ?? '').toLowerCase()))
        return constants.SQLITE_OK
      return constants.SQLITE_DENY
    })
    const statement = db.prepare(query)
    const remaining = query.slice(statement.sourceSQL.length)
    if (!/^(?:\s|--[^\r\n]*(?:\r\n|\r|\n|$)|\/\*[\s\S]*?\*\/)*$/.test(remaining))
      throw new Error('SQL requires exactly one statement')
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement.columns()
    if (!columns.length) throw new Error('SQL statement must return columns')
    const header = columns.map((column) => escape(column.name, true)).join('\t')
    const rows = [header]
    const { length: headerLength } = header
    let length = headerLength
    let reason = ''
    if (length > maxOutput) return '[truncated: output limit]'
    for (const row of statement.iterate()) {
      if (rows.length > limit) {
        reason = 'row limit'
        break
      }
      const line = Object.values(row)
        .map((value) => escape(value))
        .join('\t')
      if (length + line.length + 1 > maxOutput) {
        reason = 'output limit'
        break
      }
      rows.push(line)
      length += line.length + 1
    }
    if (reason) {
      if (reason === 'row limit' && length + '[truncated: row limit]'.length + 1 > maxOutput)
        reason = 'row and output limits'
      const footer = `[truncated: ${reason}]`
      while (rows.length && length + footer.length + 1 > maxOutput) {
        const removed = rows.pop()
        length -= (removed?.length ?? 0) + 1
      }
      rows.push(footer)
    }
    return rows.join('\n')
  } finally {
    db.close()
  }
}

process.once('message', (data: { path: string; query: string; limit: number }) => {
  try {
    process.send?.({ text: execute(data.path, data.query, data.limit) }, () =>
      process.disconnect?.()
    )
  } catch (error) {
    process.send?.({ error: String(error).replace(/[\r\n]+/g, ' ') }, () => process.disconnect?.())
  }
})
