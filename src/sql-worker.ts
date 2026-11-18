import { validateReference } from './reference.js'
import { installSqlAuthorizer } from './sql-authorization.js'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'

import type { SQLOutputValue, StatementSync } from 'node:sqlite'

const maxOutput = 32000
const maxSqliteValueBytes = 32 * 1024 * 1024
const maxWorkerRssBytes = 192 * 1024 * 1024
const memorySampleMs = 20

const escapedCharacters = new Map([
  ['\\', '\\\\'],
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\r', '\\r']
])

type Cell = Exclude<SQLOutputValue, Uint8Array> | Readonly<Pick<Uint8Array, 'toString'>>

function execute(path: string, query: string, limit: number): string {
  const db = new DatabaseSync(path, { allowExtension: false, readOnly: true })

  try {
    db.limits.length = maxSqliteValueBytes
    validateReference(db)

    const withSqlExecution = installSqlAuthorizer(db)

    const statement = db.prepare(query)

    if (!isCommentTail(query, statement.sourceSQL.length)) {
      throw new Error('SQL requires exactly one statement')
    }

    statement.setReadBigInts(true)
    statement.setReturnArrays(true)

    return withSqlExecution(() => render(statement, limit))
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

  const header = renderLine(
    columns.map((column) => column.name),
    maxOutput,
    true
  )

  if (header === undefined) {
    return '[truncated: output limit]'
  }

  let { length } = header
  let reason = ''
  const rows = [header]

  for (const row of statement.iterate()) {
    if (rows.length > limit) {
      reason = 'row limit'
      break
    }

    const line = renderLine(Object.values(row), maxOutput - length - 1)

    if (line === undefined) {
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

function renderLine(values: readonly Cell[], budget: number, header = false): string | undefined {
  const cells: string[] = []
  let remaining = budget

  for (const value of values) {
    if (cells.length > 0) {
      remaining -= 1
    }

    const cell = escape(value, remaining, header)

    if (cell === undefined) {
      return undefined
    }
    cells.push(cell)
    remaining -= cell.length
  }

  return cells.join('\t')
}

function escape(value: Cell, budget: number, header: boolean): string | undefined {
  if (value === null) {
    return budget >= 4 ? 'NULL' : undefined
  }
  if (value instanceof Uint8Array) {
    if (2 + value.byteLength * 2 > budget) {
      return undefined
    }
    return `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}`
  }

  const text = String(value)

  if (text.length > budget) {
    return undefined
  }
  if (!header && text === 'NULL') {
    return budget >= 5 ? '\\NULL' : undefined
  }

  const special = /[\\\t\n\r]/gu
  let length = text.length

  while (special.test(text)) {
    length += 1
    if (length > budget) {
      return undefined
    }
  }

  return length === text.length
    ? text
    : text.replaceAll(special, (character) => escapedCharacters.get(character) ?? character)
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
  let overBudget = false
  const monitor = setInterval(() => {
    if (process.memoryUsage.rss() <= maxWorkerRssBytes) {
      return
    }

    overBudget = true
    clearInterval(monitor)
    process.send?.({ error: 'SQL worker exceeded its memory budget' }, killWorkerProcess)
  }, memorySampleMs)

  thread.once('message', (message: Result) => {
    result = message
  })
  thread.once('error', (error) => {
    result = { error: String(error).replaceAll(/[\r\n]+/gu, ' ') }
  })
  thread.once('exit', (code) => {
    clearInterval(monitor)
    if (overBudget) {
      return
    }

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
