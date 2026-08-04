// =============================================================================
// Deploy Live Response library files via the Defender API.
//
// Reconciliation is an upsert by (case-insensitive) file name: every declared
// file is uploaded with OverrideIfExists=true, which both creates a new file
// and overwrites an existing one with the same name. This mirrors the
// indicators / detection-rules "declared state always wins" convention rather
// than skip-if-unchanged, since there is no reliable way to compare declared
// content against live content (the API returns a sha256, not the bytes — see
// the drift check for how that sha256 IS used to detect real drift).
//
// Progress is recorded as we go so a partial failure can be rolled back: each
// entry captures whether the file already existed (existed: true — rollback
// cannot restore its unknown prior content, see rollback.ts) or was newly
// created by this deploy (existed: false — rollback deletes it cleanly).
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from '../../lib/mde'
import { extractLibraryFileSpecs, fileNameKey, type LibraryFileSpec, type LiveLibraryFile } from './validate'

/** What rollback needs to undo one uploaded library file. */
export interface LibraryFileRollbackEntry {
  key: string
  fileName: string
  /** True when a file with this name already existed and was OVERWRITTEN (content is not restorable — see rollback.ts). */
  existed: boolean
}

/** List every library file's metadata (never its content). Throws on a non-OK response. */
export async function listLibraryFiles(client: MdeClient): Promise<LiveLibraryFile[]> {
  const res = await client.request('GET', '/libraryfiles')
  if (!res.ok) throw new Error(`Failed to list Live Response library files: ${mdeErrorMessage(res)}`)
  return parseJson<{ value?: LiveLibraryFile[] }>(res.body)?.value ?? []
}

/** Build the multipart/form-data body for one spec's upload. */
export function buildLibraryUploadForm(spec: LibraryFileSpec): FormData {
  const form = new FormData()
  form.append('File', new Blob([spec.content], { type: 'text/plain' }), spec.fileName)
  form.append('Description', spec.description)
  form.append('ParametersDescription', spec.parametersDescription)
  form.append('OverrideIfExists', 'true')
  return form
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiHost } = built

  const specs = extractLibraryFileSpecs(ctx.canvas).filter((s) => s.fileName && s.content)
  const rollbackState: LibraryFileRollbackEntry[] = []
  const uploaded: string[] = []

  try {
    const existing = await listLibraryFiles(client)
    const existingKeys = new Set(existing.filter((f) => f.fileName).map((f) => fileNameKey(f.fileName as string)))

    for (const spec of specs) {
      const key = fileNameKey(spec.fileName)
      const existed = existingKeys.has(key)

      const res = await client.postMultipart('/libraryfiles', buildLibraryUploadForm(spec))
      if (!res.ok) throw new Error(`Failed to upload library file "${spec.fileName}": ${mdeErrorMessage(res)}`)

      rollbackState.push({ key, fileName: spec.fileName, existed })
      uploaded.push(spec.fileName)
    }

    return {
      success: true,
      message: `Uploaded ${uploaded.length} Live Response library file(s) to ${apiHost}`,
      artifacts: { apiHost, uploaded },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Live Response library deployment failed after ${uploaded.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, uploaded },
      rollbackData: { previousState: rollbackState },
    }
  }
}
