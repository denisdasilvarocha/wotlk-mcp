import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export function packagedServer(directory: string, database: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [path.join(directory, 'package/dist/index.mjs')],
    env: { ...process.env, WOTLK_MCP_DB: database }
  })
}

export function unpackPackage(directory: string): void {
  const archive = packPackage(directory)

  execFileSync('tar', ['-xzf', archive, '-C', directory])
  symlinkSync(
    path.resolve('node_modules'),
    path.join(directory, 'package', 'node_modules'),
    'junction'
  )
}

export function packPackage(directory: string): string {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'cmd',
      ['/d', '/s', '/c', `vp pm pack --pack-destination "${directory}"`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true
      }
    )

    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr)
  } else execFileSync('vp', ['pm', 'pack', '--pack-destination', directory], { stdio: 'pipe' })

  const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))

  if (!archive) throw new Error('Package archive not created')

  return path.join(directory, archive)
}
