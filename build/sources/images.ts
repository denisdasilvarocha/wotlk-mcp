import { execFileSync } from 'node:child_process'
import { z } from 'zod'

export function run(command: string, commandArgs: readonly string[]): string {
  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

export function image(reference: string, name: string): string {
  try {
    const manifest = z
      .object({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        manifests: z
          .array(
            z.object({
              platform: z
                .object({ architecture: z.string().optional(), os: z.string().optional() })
                .optional()
            })
          )
          .optional()
      })
      .parse(
        JSON.parse(
          run('docker', [
            'buildx',
            'imagetools',
            'inspect',
            reference,
            '--format',
            '{{json .Manifest}}'
          ])
        )
      )

    if (
      name !== 'node' &&
      manifest.manifests?.some(
        (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64'
      ) !== true
    ) {
      throw new Error(`Image ${reference}@${manifest.digest} has no linux/amd64 platform`)
    }

    return `${name}@${manifest.digest}`
  } catch (error) {
    throw new Error(`Cannot resolve image ${reference}: ${String(error)}`, { cause: error })
  }
}

export function worldRevision(imageReference: string): string {
  try {
    const slsa = z.object({
      buildDefinition: z.object({
        externalParameters: z.object({
          request: z.object({
            root: z.object({
              request: z.object({
                args: z.object({
                  'vcs:revision': z.string().regex(/^[a-f0-9]{40}$/iu),
                  'vcs:source': z.literal('https://github.com/azerothcore/azerothcore-wotlk')
                })
              })
            })
          })
        })
      })
    })
    const provenance = z
      .object({
        SLSA: slsa.optional(),
        'linux/amd64': z.object({ SLSA: slsa }).optional()
      })
      .parse(
        JSON.parse(
          run('docker', [
            'buildx',
            'imagetools',
            'inspect',
            imageReference,
            '--format',
            '{{json .Provenance}}'
          ])
        )
      )
    let selected = provenance.SLSA

    selected ??= provenance['linux/amd64']?.SLSA

    if (!selected) {
      throw new Error('missing linux/amd64 SLSA source revision')
    }

    return selected.buildDefinition.externalParameters.request.root.request.args[
      'vcs:revision'
    ].toLowerCase()
  } catch (error) {
    throw new Error(`Invalid provenance for ${imageReference}: ${String(error)}`, { cause: error })
  }
}
