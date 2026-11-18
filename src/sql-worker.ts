import { validateReference } from './reference.js'
import { DatabaseSync, constants } from 'node:sqlite'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'

import type { SQLOutputValue, StatementSync } from 'node:sqlite'

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

type Cell = Exclude<SQLOutputValue, Uint8Array> | Readonly<Pick<Uint8Array, 'toString'>>

function execute(path: string, query: string, limit: number): string {
  const db = new DatabaseSync(path, { allowExtension: false, readOnly: true })

  try {
    validateReference(db)
    db.setAuthorizer((action, arg1) => {
      if (actions.has(action)) {
        return constants.SQLITE_OK
      }
      if (action === constants.SQLITE_PRAGMA && pragmas.has((arg1 ?? '').toLowerCase())) {
        return constants.SQLITE_OK
      }

      return constants.SQLITE_DENY
    })

    const statement = db.prepare(query)

    if (!isCommentTail(query, statement.sourceSQL.length)) {
      throw new Error('SQL requires exactly one statement')
    }

    statement.setReadBigInts(true)
    statement.setReturnArrays(true)

    return render(statement, limit)
  } finally {
    db.close()
  }
}

function isCommentTail(query: string, start: number): boolean {
  let i = start

  while (i < query.length) {
    if (/\s/u.test(query[i])) {
      i++
    } else if (query[i] === '-' && query[i + 1] === '-') {
      i += 2
      while (i < query.length && query[i] !== '\r' && query[i] !== '\n') {
        i++
      }
    } else if (query[i] === '/' && query[i + 1] === '*') {
      i += 2
      while (i < query.length && !(query[i] === '*' && query[i + 1] === '/')) {
        i++
      }
      if (i === query.length) {
        return false
      }
      i += 2
    } else {
      return false
    }
  }

  return true
}

function render(statement: Readonly<StatementSync>, limit: number): string {
  const columns = statement.columns()

  if (columns.length === 0) {
    throw new Error('SQL statement must return columns')
  }

  const header = columns.map((column) => escape(column.name, true)).join('\t')
  let { length } = header
  let reason = ''
  const rows = [header]

  if (length > maxOutput) {
    return '[truncated: output limit]'
  }

  for (const row of statement.iterate()) {
    if (rows.length > limit) {
      reason = 'row limit'
      break
    }

    const line = Object.values(row)
      .map((value: Cell) => escape(value))
      .join('\t')

    if (length + line.length + 1 > maxOutput) {
      reason = 'output limit'
      break
    }

    rows.push(line)
    length += line.length + 1
  }

  if (reason) {
    if (reason === 'row limit' && length + '[truncated: row limit]'.length + 1 > maxOutput) {
      reason = 'row and output limits'
    }

    const footer = `[truncated: ${reason}]`

    while (rows.length > 0 && length + footer.length + 1 > maxOutput) {
      const removed = rows.pop()

      length -= (removed?.length ?? 0) + 1
    }

    rows.push(footer)
  }

  return rows.join('\n')
}

function escape(value: Cell, header = false): string {
  if (value === null) {
    return 'NULL'
  }
  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString('hex')}`
  }

  const text = String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('	', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')

  if (!header && text === 'NULL') {
    return '\\NULL'
  }

  return text
}

type Request = Readonly<{ deadline: number; path: string; query: string; limit: number }>
type Result = Readonly<{ text: string } | { error: string }>

function executeRequest(data: Request): Result {
  try {
    return { text: execute(data.path, data.query, data.limit) }
  } catch (error) {
    return { error: String(error).replaceAll(/[\r\n]+/gu, ' ') }
  }
}

function killWorkerProcess(): void {
  process.kill(process.pid, 'SIGKILL')
}

function supervise(data: Request): void {
  const timer = setTimeout(killWorkerProcess, Math.max(0, data.deadline - Date.now()))
  const thread = new Worker(new URL(import.meta.url))
  let result: Result | undefined

  thread.once('message', (message: Result) => {
    result = message
  })
  thread.once('error', (error) => {
    result = { error: String(error).replaceAll(/[\r\n]+/gu, ' ') }
  })
  thread.once('exit', (code) => {
    const response = result ?? { error: `SQL worker thread exited unexpectedly (${code})` }
    process.send?.(response, () => {
      clearTimeout(timer)
      process.off('disconnect', killWorkerProcess)
      if (process.connected) {
        process.disconnect?.()
      }
    })
  })
  thread.postMessage(data, undefined)
}

if (isMainThread) {
  process.once('disconnect', killWorkerProcess)
  process.once('message', supervise)
} else {
  parentPort?.once('message', (data: Request) => {
    parentPort?.postMessage(executeRequest(data), undefined)
  })
}
