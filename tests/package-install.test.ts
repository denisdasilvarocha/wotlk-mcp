import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vite-plus/test'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

function run(command: string, args: string[], cwd?: string): void {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'cmd',
      ['/d', '/s', '/c', `${command} ${args.map((arg) => `"${arg}"`).join(' ')}`],
      {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsVerbatimArguments: true
      }
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr)
  } else execFileSync(command, args, { cwd, stdio: 'pipe', timeout: 120_000 })
}

test('a clean installed tarball exposes an executable MCP server without a bundled database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-install-'))
  const client = new Client({ name: 'install-test', version: '1' })
  try {
    const database = path.join(directory, 'reference.sqlite')
    run('vpx', ['scripts/build-reference.ts', database])
    run('vp', ['pm', 'pack', '--pack-destination', directory])
    const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))
    if (!archive) throw new Error('Package archive not created')
    const files = execFileSync('tar', ['-tzf', path.join(directory, archive)], { encoding: 'utf8' })
    expect(files).not.toMatch(/\.sqlite(?:\.br)?$/m)
    expect(files).not.toContain('src/')
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'clean-install',
        private: true,
        dependencies: { 'wotlk-mcp': `file:${path.join(directory, archive)}` }
      })
    )
    run('vp', ['install'], directory)
    const installed = JSON.parse(
      readFileSync(path.join(directory, 'node_modules/wotlk-mcp/package.json'), 'utf8')
    )
    expect(installed.version).toBe(version)
    let command = 'npx'
    let args = ['-y', `wotlk-mcp@${version}`]
    if (process.platform === 'win32') {
      command = 'cmd'
      args = ['/d', '/s', '/c', `npx -y wotlk-mcp@${version}`]
    }
    await client.connect(
      new StdioClientTransport({
        command,
        args,
        cwd: directory,
        env: { ...process.env, WOTLK_MCP_DB: database }
      })
    )
    const result = await client.callTool({
      name: 'get',
      arguments: { ids: ['offset:Globals::PlayerName'] }
    })
    expect(JSON.stringify(result)).toContain('offset:Globals::PlayerName')
    expect(result.isError).not.toBe(true)
  } finally {
    await client.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}, 180_000)
