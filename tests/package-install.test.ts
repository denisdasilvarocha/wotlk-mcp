import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vite-plus/test'

test('a clean installed tarball exposes an executable MCP server without a bundled database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-install-'))
  const client = new Client({ name: 'install-test', version: '1' })
  try {
    const database = path.join(directory, 'reference.sqlite')
    execFileSync('vpx', ['scripts/build-reference.ts', database], { stdio: 'pipe' })
    execFileSync('vp', ['pm', 'pack', '--pack-destination', directory], { stdio: 'pipe' })
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
    execFileSync('vp', ['install'], { cwd: directory, stdio: 'pipe', timeout: 120_000 })
    const installed = JSON.parse(
      readFileSync(path.join(directory, 'node_modules/wotlk-mcp/package.json'), 'utf8')
    )
    expect(installed.version).toBe('1.0.0')
    await client.connect(
      new StdioClientTransport({
        command: path.join(directory, 'node_modules/.bin/wotlk-mcp'),
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
    rmSync(directory, { recursive: true, force: true })
  }
}, 180_000)
