import { fork } from 'node:child_process'

import type { ChildProcess } from 'node:child_process'

const activeWorkers = new Set<ChildProcess>()
const timeoutMs = 5000
const timeoutMessage = 'SQL query timed out after 5 seconds'
const maxWorkers = 4
const maxQueuedWorkers = 32
const queuedWorkers: Array<{ start: () => void; cancel: () => void }> = []

function startQueuedWorkers(): void {
  while (activeWorkers.size < maxWorkers && queuedWorkers.length > 0) {
    queuedWorkers.shift()?.start()
  }
}

export function terminateSqlWorkers(): void {
  for (const worker of activeWorkers) {
    worker.kill('SIGKILL')
  }
  for (const queued of queuedWorkers.splice(0)) {
    queued.cancel()
  }
}

export function runSql(
  path: string,
  query: string,
  limit: number,
  signal: Readonly<AbortSignal>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    if (signal.aborted) {
      abort()
      return
    }

    const start = (): void => {
      signal.removeEventListener('abort', cancel)
      let worker: ChildProcess
      const deadline = Date.now() + timeoutMs
      try {
        worker = fork(new URL('./sql-worker.mjs', import.meta.url), [], {
          killSignal: 'SIGKILL',
          signal,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        })
      } catch (error) {
        reject(error)
        return
      }
      activeWorkers.add(worker)

      const timer = setTimeout(
        () => {
          worker.kill('SIGKILL')
          reject(new Error(timeoutMessage))
        },
        Math.max(0, deadline - Date.now())
      )

      worker.once('message', (result: Readonly<{ text?: string; error?: string }>) => {
        clearTimeout(timer)

        if (result.error !== undefined) {
          reject(new Error(result.error))
        } else {
          resolve(result.text ?? '')
        }
      })
      worker.once('error', (error: Readonly<Error>) => {
        clearTimeout(timer)
        reject(error)
      })
      worker.once('close', (code) => {
        activeWorkers.delete(worker)
        clearTimeout(timer)
        reject(
          new Error(
            !signal.aborted && Date.now() >= deadline
              ? timeoutMessage
              : `SQL worker exited unexpectedly (${code})`
          )
        )
        startQueuedWorkers()
      })
      try {
        worker.send({ deadline, limit, path, query })
      } catch (error) {
        clearTimeout(timer)
        worker.kill('SIGKILL')
        reject(error)
      }
    }
    const cancel = (): void => {
      const index = queuedWorkers.findIndex((queued) => queued.start === start)
      if (index !== -1) queuedWorkers.splice(index, 1)
      signal.removeEventListener('abort', cancel)
      abort()
    }

    if (activeWorkers.size < maxWorkers) {
      start()
    } else if (queuedWorkers.length < maxQueuedWorkers) {
      queuedWorkers.push({ start, cancel })
      signal.addEventListener('abort', cancel, { once: true })
    } else {
      reject(new Error('SQL worker queue is full; retry shortly'))
    }
  })
}
