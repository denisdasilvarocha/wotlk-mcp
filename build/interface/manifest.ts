import { readClientManifest, type ClientManifestFile } from '../shared/client-manifest.ts'

const eligible = /^Interface\/(?:FrameXML|GlueXML|AddOns\/Blizzard_[^/]+)\/.+\.(?:lua|xml|toc)$/iu

export function interfaceFiles(directory: string, manifestHash: string): ClientManifestFile[] {
  const files = readClientManifest(directory, manifestHash)
    .filter((file) => eligible.test(file.path))
    .toSorted((a, b) => a.path.localeCompare(b.path, 'en'))

  if (
    files.length === 0 ||
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length
  ) {
    throw new Error('Empty or duplicate Interface inventory')
  }

  return files
}
