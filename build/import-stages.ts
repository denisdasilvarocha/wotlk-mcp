import path from 'node:path'

import { importClientData } from './client/index.ts'
import { importCodex, readCodex } from './codex/index.ts'
import { importInterface } from './interface/index.ts'
import { importNative } from './native/index.ts'
import { initReference } from './offsets.ts'
import type { Sources } from './sources/index.ts'
import { importWorld } from './world/index.ts'

type Run = <T>(label: string, action: () => T | Promise<T>) => Promise<T>

type BuildSources = Readonly<Omit<Sources, 'azerothcore' | 'codex' | 'wowdbdefs'>> & {
  readonly azerothcore: Readonly<Sources['azerothcore']>
  readonly codex: Readonly<Omit<Sources['codex'], 'files'>> & {
    readonly files: Readonly<Record<string, string>>
  }
  readonly wowdbdefs: Readonly<Sources['wowdbdefs']>
}

export async function runImportStages(
  run: Run,
  database: string,
  output: string,
  sources: BuildSources
): Promise<void> {
  await run('offsets', () => {
    initReference(database)
  })
  await run('codex', async () => {
    importCodex(database, sources.codex, await readCodex(sources.codex, sources.codexNodeImage))
  })
  await run('client data', () => {
    importClientData(database, sources.client, sources.clientManifestHash, sources.wowdbdefs)
  })
  await run('interface', () => {
    importInterface(database, sources.client, sources.clientManifestHash)
  })
  await run('world', () =>
    importWorld(
      database,
      sources.azerothcore,
      sources.worldImporterImage,
      path.join(output, 'world')
    )
  )
  await run('native', () => {
    importNative(
      database,
      sources.client,
      sources.clientManifestHash,
      'data/native-widget-decisions.json'
    )
  })
}
