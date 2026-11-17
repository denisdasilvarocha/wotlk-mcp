import { fork } from 'node:child_process'

export function runSql(
  path: string,
  query: string,
  limit: number,
  signal: Readonly<AbortSignal>
): Promise<string> {
  return new Promise((resolve, reject) => {
    // A process can be killed while SQLite is executing native code; a thread cannot.
    const worker = fork(new URL('./sql-worker.mjs', import.meta.url), [], {
      killSignal: 'SIGKILL',
      signal,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    const timer = setTimeout(() => {
      worker.kill('SIGKILL')
      reject(new Error('SQL query timed out after 5 seconds'))
    }, 5000)

    worker.send({ limit, path, query })
    worker.once('message', (result: Readonly<{ text?: string; error?: string }>) => {
      clearTimeout(timer)

      if (result.error !== undefined && result.error !== '') {
        reject(new Error(result.error))
      } else {
        resolve(result.text ?? '')
      }
    })
    worker.once('error', (error: Readonly<Error>) => {
      clearTimeout(timer)
      reject(error)
    })
    // 'exit' can fire before the result message is read; 'close' waits for the IPC channel.
    worker.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`SQL worker exited unexpectedly (${code})`))
    })
  })
}
