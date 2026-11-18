import { fork } from 'node:child_process'

import type { ChildProcess } from 'node:child_process'

const activeWorkers = new Set<ChildProcess>()
const timeoutMs = 5000
const timeoutMessage = 'SQL query timed out after 5 seconds'

export function terminateSqlWorkers(): void {
  for (const worker of activeWorkers) {
    worker.kill('SIGKILL')
  }
}

export function runSql(
  path: string,
  query: string,
  limit: number,
  signal: Readonly<AbortSignal>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const worker = fork(new URL('./sql-worker.mjs', import.meta.url), [], {
      killSignal: 'SIGKILL',
      signal,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
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
    })
    worker.send({ deadline, limit, path, query })
  })
}
