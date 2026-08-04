import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, type RecordedFutureClient } from '../../lib/recordedFutureApi'
import { fusionErrorMessage, fusionPaths, normalizePath } from './_shared'

/**
 * Deploy Recorded Future Fusion Files over the Fusion Files API:
 *   read:   GET  /fusion/v3/files/{path}   → the file's current bytes (existence + rollback)
 *   upload: POST /fusion/v3/files/{path}   → replace the file's content with the declared bytes
 *
 * The full PATH is the stable identity used to upsert. A read that returns 404
 * means the file does not exist yet (created by this deploy); any other read
 * failure is treated as a deploy failure for that item rather than overwriting
 * blind. A file whose live content already equals the declared content is
 * skipped (no write).
 *
 * rollbackData records, per file, whether it already existed and — when it did —
 * its exact PRIOR content, so rollback can restore it verbatim (or delete a file
 * this deploy created).
 *
 * VERIFY the /home/{org}/ path-namespace semantics against a live account.
 */
interface RollbackEntry {
  path: string
  existed: boolean
  priorContent: string | null
  changed: boolean
}

/** Read a Fusion file's current content. `found: false` on 404; throws on any other failure. */
async function readFile(
  client: RecordedFutureClient,
  path: string,
): Promise<{ found: boolean; content: string }> {
  const res = await client.raw('GET', fusionPaths.file(path))
  if (res.status === 404) return { found: false, content: '' }
  if (!res.ok) throw new Error(fusionErrorMessage(res.status, res.body))
  return { found: true, content: res.body }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for Fusion File deployment' }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const path = normalizePath(item.fields.path)
    const content = String(item.fields.content ?? '')
    if (!path) continue

    const entry: RollbackEntry = { path, existed: false, priorContent: null, changed: false }

    try {
      const current = await readFile(client, path)
      entry.existed = current.found
      if (current.found) entry.priorContent = current.content

      if (current.found && current.content === content) {
        previous.push(entry)
        applied.push(`${path} (unchanged)`)
        continue
      }

      const res = await client.raw('POST', fusionPaths.file(path), { body: content })
      if (!res.ok) {
        failures.push(`upload "${path}": ${fusionErrorMessage(res.status, res.body)}`)
        previous.push(entry)
        continue
      }

      entry.changed = true
      previous.push(entry)
      applied.push(path)
    } catch (error) {
      failures.push(`"${path}": ${error instanceof Error ? error.message : 'Unknown error'}`)
      previous.push(entry)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Fusion File deploy applied ${applied.length} file(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} Fusion File(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
