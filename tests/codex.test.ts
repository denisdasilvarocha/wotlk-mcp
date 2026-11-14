import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vite-plus/test'

test('Codex importer preserves source details and rejects altered inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-'))
  const files: Record<string, string> = {
    'api-functions': `export const API_FUNCTIONS = [{name:'Foo',description:'Does foo',category:'Demo',parameters:[{name:'x'}],returns:[{name:'y'}],memoryAddress:'0x1234'}]`,
    events: `export const EVENTS = [{name:'EVENT',description:'Event',category:'Demo',parameters:[]}]`,
    widgets: `export const WIDGETS = [{name:'Region',description:'Widget',methods:[{name:'Region:SetPoint(point)',signature:'Region:SetPoint(point)',description:'Anchors',parameters:[{name:'point'}],returns:[]}],inheritedMethods:[],scriptHandlers:[{name:'OnShow'}]}]`,
    cvars: `export const CVARS = [{name:'testCVar',defaultValue:'1',description:'',category:'General'}]`,
    'data-types': `export const DATA_TYPES = [{name:'anchorPoint',description:'Anchors',values:[{name:'CENTER'}]}]`,
    'combat-log-events': `export const COMBAT_LOG_PREFIXES = [{name:'SPELL',arguments:[{name:'spellId'}]}]; export const COMBAT_LOG_SUB_EVENTS = [{name:'SPELL_DAMAGE',description:'Damage',prefixes:['SPELL'],arguments:[{name:'amount'}]}]`,
    'secure-templates': `export const SECURE_TEMPLATES = [{name:'SecureActionButtonTemplate',description:'Secure',attributes:[{name:'type'}],examples:[]}]`,
    'book-chapters': `export const CHAPTER_PAGES = {1:45}`
  }
  mkdirSync(path.join(dir, 'src/data'), { recursive: true })
  const hashes: Record<string, string> = {}
  for (const [name, text] of Object.entries(files)) {
    const file = `src/data/${name}.ts`
    writeFileSync(path.join(dir, file), text)
    hashes[file] = createHash('sha256').update(text).digest('hex')
  }
  const manifest = path.join(dir, 'pins.json')
  writeFileSync(manifest, JSON.stringify({ revision: 'fixture', files: hashes }))
  const dbPath = path.join(dir, 'reference.sqlite')
  execFileSync('vpx', ['scripts/build-reference.ts', dbPath], { stdio: 'pipe' })
  execFileSync('node', ['scripts/import-codex.ts', dbPath, dir, manifest], { stdio: 'pipe' })
  const db = new DatabaseSync(dbPath, { readOnly: true })
  expect(db.prepare("SELECT hint, search_text FROM record WHERE id='fn:Foo'").get()).toMatchObject({
    hint: 'Demo',
    search_text: 'Does foo'
  })
  expect(db.prepare('SELECT parameters, memoryAddress FROM lua_fn').get()).toMatchObject({
    parameters: '[{"name":"x"}]',
    memoryAddress: '0x1234'
  })
  expect(
    db.prepare("SELECT name FROM record WHERE id='method:Region:SetPoint'").get()
  ).toMatchObject({ name: 'SetPoint' })
  expect(db.prepare('SELECT methods, scriptHandlers FROM lua_widget').get()).toMatchObject({
    methods: '["SetPoint"]',
    scriptHandlers: '[{"name":"OnShow"}]'
  })
  expect(db.prepare('SELECT arguments FROM lua_cle').get()).toMatchObject({
    arguments: '[{"name":"spellId"},{"name":"amount"}]'
  })
  expect(db.prepare('SELECT count(*) AS n FROM link').get()).toMatchObject({ n: 0 })
  db.close()
  execFileSync('vp', ['pm', 'pack', '--pack-destination', dir], { stdio: 'pipe' })
  const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(dir, archive), '-C', dir])
  symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'dir')
  const client = new Client({ name: 'codex-test', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dir, 'package/dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: dbPath }
    })
  )
  const result = await client.callTool({
    name: 'get',
    arguments: { ids: ['fn:Foo', 'method:Region:SetPoint', 'widget:Region'] }
  })
  expect(JSON.stringify(result)).toContain('memoryAddress: 0x1234')
  expect(JSON.stringify(result)).toContain('declaringWidget: Region')
  expect(JSON.stringify(result)).toContain('scriptHandlers:')
  await client.close()
  writeFileSync(path.join(dir, 'src/data/cvars.ts'), 'corrupted')
  expect(() =>
    execFileSync('node', ['scripts/import-codex.ts', dbPath, dir, manifest], { stdio: 'pipe' })
  ).toThrow('Codex SHA-256 mismatch')
})
