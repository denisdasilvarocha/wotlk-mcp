import { decode, type Column } from './data.ts'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function createWorldScanner(mysqlArgs: readonly string[], signal: Readonly<AbortSignal>) {
  return async function scan(
    query: string,
    table: string,
    columns: readonly Column[],
    consume: (values: readonly unknown[]) => void
  ): Promise<void> {
    const child = spawn('docker', [...mysqlArgs, query], {
      killSignal: 'SIGKILL',
      signal,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let childError: Error | undefined
    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const closed = new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        childError ??= error
      })
      child.once('close', resolve)
    })

    try {
      for await (const line of createInterface({ crlfDelay: Infinity, input: child.stdout })) {
        const fields = line.split('\t')

        if (fields.length !== columns.length) {
          throw new Error('Wrong number of MySQL columns')
        }

        consume(fields.map((field, i) => decode(field, columns[i], table)))
      }
    } catch (error) {
      child.kill('SIGKILL')
      await closed
      throw error
    }

    const code = await closed

    if (childError) {
      throw childError
    }
    if (code !== 0) {
      throw new Error(`MySQL export failed (${code}): ${stderr}`)
    }
    signal.throwIfAborted()
  }
}
