import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { buildHashException, groupHashExceptions, endpointForListType, type HashException } from './_shared'

/**
 * Deploy Cortex XDR hash exceptions over the public REST API:
 *   allow list: POST /hash_exceptions/allowlist/  with { request_data: { hash_list, comment? } }
 *   block list: POST /hash_exceptions/blocklist/  with { request_data: { hash_list, comment? } }
 *
 * These two ADD endpoints are the confirmed public-API write path for this app.
 * They are ADD-ONLY: Cortex XDR exposes no public endpoint to list or remove
 * hash exceptions, so re-adding an existing hash is idempotent (VERIFY the
 * tenant's behaviour), drift cannot read live state, and rollback cannot remove
 * (see rollback.ts). rollbackData records what we added so a future
 * remove-capable version could undo it.
 *
 * VERIFY the endpoint paths + request envelope against a live Cortex XDR tenant.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for hash-exception deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const exceptions: HashException[] = []
  const added: Array<{ hash: string; listType: string }> = []
  for (const item of items) {
    const exc = buildHashException(item.fields)
    if (!exc.hash || !exc.list_type) continue
    exceptions.push(exc)
    added.push({ hash: exc.hash, listType: exc.list_type })
  }

  if (exceptions.length === 0) {
    return { success: true, message: 'No hash exceptions to apply.', artifacts: { applied: [] }, rollbackData: { added: [] } }
  }

  const groups = groupHashExceptions(exceptions)
  const applied: string[] = []

  try {
    for (const group of groups) {
      const requestData: Record<string, unknown> = { hash_list: group.hashes }
      if (group.comment) requestData.comment = group.comment
      const res = await client.call(endpointForListType(group.listType), requestData)
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Hash-exception deploy failed for ${group.listType}: ${error}`,
          artifacts: { applied },
          rollbackData: { added },
        }
      }
      applied.push(...group.hashes.map((h) => `${group.listType}:${h}`))
    }

    return {
      success: true,
      message: `Applied ${applied.length} hash exception(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { added },
    }
  } catch (error) {
    return {
      success: false,
      message: `Hash-exception deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { added },
    }
  }
}
