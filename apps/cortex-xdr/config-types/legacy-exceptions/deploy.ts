import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  LEGACY_EXCEPTION_ENDPOINTS,
  buildLegacyExceptionBody,
  findException,
  exceptionsFromReply,
  type LiveLegacyException,
} from './_shared'

/**
 * Deploy Cortex XDR legacy exceptions over the public REST API — the confirmed,
 * base-license write path for prevention-module exceptions (see _shared.ts for
 * why this is preferred over the Cloud-add-on-gated "Disable Prevention Rule"
 * API this app does not implement):
 *   read (identity + rollback): POST /legacy_exceptions/fetch/  → real list
 *   add:                        POST /legacy_exceptions/add/
 *   edit:                       POST /legacy_exceptions/edit/   (needs exception_id)
 *
 * An exception has no caller-chosen identity — Cortex assigns `exception_id` on
 * add — so this reconciles by NAME (`rule_name`): fetch -> match -> edit it by
 * id, or add a new one. rollbackData records, per name, the prior live snapshot
 * (null when it did not exist) plus the created exception_id (when created) so
 * rollback can restore or delete.
 *
 * VERIFY every endpoint path + field name against a live Cortex XDR tenant.
 */
async function listExceptions(client: CortexXdrClient): Promise<LiveLegacyException[]> {
  try {
    const res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.fetch, { search_from: 0, search_to: 1000 })
    if (!res.ok) return []
    return exceptionsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for legacy-exception deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: LiveLegacyException | null; createdId?: string }> = []
  const applied: string[] = []

  try {
    const live = await listExceptions(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      let body
      try {
        body = buildLegacyExceptionBody(item.fields)
      } catch (parseError) {
        return {
          success: false,
          message: `Legacy-exception deploy failed for "${name}": ${parseError instanceof Error ? parseError.message : 'invalid conditions'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const match = findException(live, name)
      const entry: (typeof previous)[number] = { name, prior: match }
      previous.push(entry)

      let res
      if (match?.id) {
        res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.edit, {
          exception_id: match.id,
          update_data: body,
        })
      } else {
        res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.add, body as unknown as Record<string, unknown>)
        if (res.ok && typeof res.reply === 'string' && res.reply) entry.createdId = res.reply
      }

      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Legacy-exception deploy failed for "${name}": ${error}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} legacy exception(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Legacy-exception deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
