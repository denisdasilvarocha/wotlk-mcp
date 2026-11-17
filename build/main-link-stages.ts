import { buildClientFactionSpawnLinks } from './client-faction-spawn-links.ts'
import { buildLootLinks } from './loot-links.ts'
import { importSpellEnums } from './spell-enums.ts'
import { importWorldEnums } from './world-enums.ts'
import { buildWorldLinks } from './world-links.ts'

type Run = <T>(label: string, action: () => T | Promise<T>) => Promise<T>

export async function runLinkStages(
  run: Run,
  database: string,
  azerothcore: string
): Promise<void> {
  await run('world links', () => {
    buildWorldLinks(database)
  })
  await run('loot links', () => {
    buildLootLinks(database)
  })
  await run('client and spawn links', () => {
    buildClientFactionSpawnLinks(database)
  })
  await run('world enums', () => {
    importWorldEnums(database, azerothcore)
  })
  await run('spell enums and foreign keys', () => {
    importSpellEnums(database, azerothcore)
  })
}
