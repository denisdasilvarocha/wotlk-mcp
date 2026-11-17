import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, test } from 'vite-plus/test'

import { initReference } from '../../build/offsets.ts'
import { packPackage } from '../helpers/package.ts'

const version = readVersion('package.json')

function readVersion(file: string): string {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    typeof value.version !== 'string'
  ) {
    throw new Error(`Invalid package version: ${file}`)
  }
  return value.version
}

function serverCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { args: ['/d', '/s', '/c', `npx -y wotlk-mcp@${version}`], command: 'cmd' }
  }
  return { args: ['-y', `wotlk-mcp@${version}`], command: 'npx' }
}

function run(command: string, args: readonly string[], cwd?: string): void {
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

    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(result.stderr)
    }
  } else {
    execFileSync(command, args, { cwd, stdio: 'pipe', timeout: 120_000 })
  }
}

test('a clean installed tarball exposes an executable MCP server without a bundled database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-install-'))
  const client = new Client({ name: 'install-test', version: '1' })

  try {
    const database = path.join(directory, 'reference.sqlite')

    initReference(database)

    const archive = packPackage(directory)
    const { args, command } = serverCommand()
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })

    expect(files).not.toMatch(/\.sqlite(?:\.br)?$/mu)
    expect(files).not.toContain('src/')
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        dependencies: { 'wotlk-mcp': `file:${archive}` },
        name: 'clean-install',
        private: true
      })
    )
    run('vp', ['install'], directory)

    const installed = readVersion(path.join(directory, 'node_modules/wotlk-mcp/package.json'))

    expect(installed).toBe(version)

    await client.connect(
      new StdioClientTransport({
        args,
        command,
        cwd: directory,
        env: { ...process.env, WOTLK_MCP_DB: database }
      })
    )

    const result = await client.callTool({
      arguments: { ids: ['offset:Globals::PlayerName'] },
      name: 'get'
    })

    expect(JSON.stringify(result)).toContain('offset:Globals::PlayerName')
    expect(JSON.stringify(result)).toContain('va: 0x00C79D18')
    expect(JSON.stringify(result)).not.toContain('not found:')
    expect(result.isError).not.toBe(true)
  } finally {
    await client.close()
    rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 250 })
  }
}, 180_000)
