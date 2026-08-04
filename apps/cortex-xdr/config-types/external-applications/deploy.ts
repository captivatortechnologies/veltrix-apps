import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  EXTERNAL_APPLICATION_BASE,
  buildApplicationBody,
  findApplication,
  applicationsFromResponse,
  applicationFromResponse,
  type LiveExternalApplication,
} from './_shared'

/**
 * Deploy Cortex XDR external application integrations — a genuine full CRUD
 * surface, but over the newer `/platform/integration/v1/...` REST-verb API
 * (see lib/cortexXdrApi.ts `request()`), not the RPC-style `/public_api/v1/...`
 * every other config type in this app uses:
 *   read (identity + rollback): GET  /platform/integration/v1/external-application
 *   create:                     POST /platform/integration/v1/external-application
 *   update:                     PUT  /platform/integration/v1/external-application/{application_id}
 *
 * An application has no caller-chosen identity — Cortex assigns
 * `application_id` on create — so this reconciles by NAME: list -> match a live
 * application by name -> update it by id, or create a new one. rollbackData
 * records, per name, the prior live snapshot (null when it did not exist) so
 * rollback can restore it or delete the one we created.
 *
 * VERIFY every endpoint path, the auth requirement (see cortexXdrApi.ts) and the
 * per-type connection_config shape against a live Cortex XDR tenant.
 */
async function listApplications(client: CortexXdrClient): Promise<LiveExternalApplication[]> {
  try {
    const res = await client.request('GET', EXTERNAL_APPLICATION_BASE)
    if (!res.ok) return []
    return applicationsFromResponse(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for external-application deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: LiveExternalApplication | null; created?: { application_id: number; application_type: string } }> = []
  const applied: string[] = []

  try {
    const live = await listApplications(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      let body
      try {
        body = buildApplicationBody(item.fields)
      } catch (parseError) {
        return {
          success: false,
          message: `External-application deploy failed for "${name}": ${parseError instanceof Error ? parseError.message : 'invalid connection_config'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const match = findApplication(live, name)
      const entry: (typeof previous)[number] = { name, prior: match }
      previous.push(entry)

      const res =
        match?.application_id !== undefined
          ? await client.request('PUT', `${EXTERNAL_APPLICATION_BASE}/${match.application_id}`, body)
          : await client.request('POST', EXTERNAL_APPLICATION_BASE, body)

      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `External-application deploy failed for "${name}": ${error}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      if (!match) {
        const created = applicationFromResponse(res.reply)
        if (created?.application_id !== undefined && created.application_type) {
          entry.created = { application_id: created.application_id, application_type: created.application_type }
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} external application(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `External-application deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
