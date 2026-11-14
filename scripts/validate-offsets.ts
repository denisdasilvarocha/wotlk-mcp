import { readdirSync } from 'node:fs'

import * as z from 'zod'

import { loadOffsets, offsetTopicSchema } from '../build/offsets.ts'

try {
  const [, , argument] = process.argv
  if (argument === '--schema')
    console.log(JSON.stringify(z.toJSONSchema(offsetTopicSchema), undefined, 2))
  else {
    const directory = argument ?? 'data/offsets'
    const offsets = loadOffsets(directory)
    const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
    console.log(`Validated ${offsets.length} Offset entries in ${files.length} topics`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
