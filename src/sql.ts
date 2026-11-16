import { fork } from 'node:child_process'

export function runSql(
  path: string,
  query: string,
  limit: number,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    // A process can be killed while SQLite is executing native code; a thread cannot.
    const worker = fork(new URL('./sql-worker.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      signal,
      killSignal: 'SIGKILL'
    })
    const timer = setTimeout(() => {
      worker.kill('SIGKILL')
      reject(new Error('SQL query timed out after 5 seconds'))
    }, 5000)

    worker.send({ path, query, limit })
    worker.once('message', (result: { text?: string; error?: string }) => {
      clearTimeout(timer)

      if (result.error) reject(new Error(result.error))
      else resolve(result.text ?? '')
    })
    worker.once('error', (error) => {
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
