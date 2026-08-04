import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  PREVENTION_PROFILE_ENDPOINTS,
  buildAddBody,
  buildEditBody,
  findProfile,
  profilesFromReply,
  type LivePreventionProfile,
} from './_shared'

/**
 * Deploy Cortex XDR prevention profiles — the agent security POLICY surface:
 *   read (identity + rollback): POST /endpoints/get_profiles/       → REAL, { request_data } envelope
 *   add:                        POST /profiles/prevention/add/       → RAW body (no envelope)
 *   edit:                       POST /profiles/prevention/edit/      → RAW body (no envelope)
 *
 * A profile is identified by NAME: list -> match a live profile by name -> edit
 * it by id, or add a new one. Default profiles (is_default) cannot be edited
 * per Cortex's own docs — this surfaces as a clear deploy failure rather than a
 * silent no-op. There is NO documented delete endpoint, so rollbackData records
 * only the prior body for restore (see rollback.ts for the add-only limitation).
 *
 * VERIFY every endpoint path + the request envelope (see _shared.ts) against a
 * live Cortex XDR tenant.
 */
async function listProfiles(client: CortexXdrClient): Promise<LivePreventionProfile[]> {
  try {
    const res = await client.call(PREVENTION_PROFILE_ENDPOINTS.get, { type: 'prevention' })
    if (!res.ok) return []
    return profilesFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for prevention-profile deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: LivePreventionProfile | null }> = []
  const applied: string[] = []

  try {
    const live = await listProfiles(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const match = findProfile(live, name)
      previous.push({ name, prior: match })

      if (match?.is_default) {
        return {
          success: false,
          message: `Prevention-profile deploy failed for "${name}": Cortex XDR does not allow editing default profiles.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      let res
      try {
        if (match?.id !== undefined) {
          res = await client.post(PREVENTION_PROFILE_ENDPOINTS.edit, buildEditBody(match.id, item.fields))
        } else {
          res = await client.post(PREVENTION_PROFILE_ENDPOINTS.add, buildAddBody(item.fields))
        }
      } catch (parseError) {
        return {
          success: false,
          message: `Prevention-profile deploy failed for "${name}": ${parseError instanceof Error ? parseError.message : 'invalid modules'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Prevention-profile deploy failed for "${name}": ${error}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} prevention profile(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Prevention-profile deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
