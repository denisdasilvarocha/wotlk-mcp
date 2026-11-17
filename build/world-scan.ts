import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import { decode, type Column } from './world-data.ts'

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
    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`MySQL export failed (${code}): ${stderr}`))
        }
      })
    })

    try {
      for await (const line of createInterface({ crlfDelay: Infinity, input: child.stdout })) {
        const fields = line.split('\t')

        if (fields.length !== columns.length) {
          throw new Error('Wrong number of MySQL columns')
        }

        consume(fields.map((field, i) => decode(field, columns[i], table)))
      }

      await exited
    } catch (error) {
      child.kill('SIGKILL')
      await exited.catch(() => {})
      throw error
    }
  }
}
