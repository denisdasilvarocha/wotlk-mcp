import { DatabaseSync, constants } from 'node:sqlite'
const maxOutput = 32000
const pragmas = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'foreign_key_list'])
const actions = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE])

function escape(value: unknown): string {
  if (value === null) return 'NULL'
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`
  const text = String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  if (text === 'NULL') return '\\NULL'
  return text
}

function execute(path: string, query: string, limit: number): string {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try {
    db.setAuthorizer((action, arg1) => {
      if (actions.has(action)) return constants.SQLITE_OK
      if (action === constants.SQLITE_PRAGMA && pragmas.has((arg1 ?? '').toLowerCase())) return constants.SQLITE_OK
      return constants.SQLITE_DENY
    })
    const statement = db.prepare(query)
    const remaining = query.slice(statement.sourceSQL.length)
    if (!/^(?:\s|--[^\r\n]*(?:\r\n|\r|\n|$)|\/\*[\s\S]*?\*\/)*$/.test(remaining)) {
      throw new Error('SQL requires exactly one statement')
    }
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const header = statement.columns().map((column) => escape(column.name)).join('\t')
    const rows = [header]
    let length = header.length
    let reason = ''
    if (length > maxOutput) return '[truncated: output limit]'
    for (const row of statement.iterate()) {
      if (rows.length > limit) {
        reason = 'row limit'
        break
      }
      const line = Object.values(row).map(escape).join('\t')
      if (length + line.length + 1 > maxOutput) {
        reason = 'output limit'
        break
      }
      rows.push(line)
      length += line.length + 1
    }
    if (reason) {
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
    process.send?.({ text: execute(data.path, data.query, data.limit) }, () => process.disconnect())
  } catch (error) {
    process.send?.({ error: String(error).replace(/[\r\n]+/g, ' ') }, () => process.disconnect())
  }
})
