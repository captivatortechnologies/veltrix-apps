import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import { extractCustomEmailSpecs, buildCustomEmailBody, priorFieldsOf, type JumpCloudCustomEmail } from './_shared'

/** One rollback record per applied Custom Email override. */
export interface CustomEmailRollbackEntry {
  type: string
  /** Whether the override already existed (update) or was created by this deploy. */
  existed: boolean
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud Custom Email overrides over the API v2 (/customemails), keyed
 * by `type` (a fixed enum with no separate generated id):
 *   read:   GET    /customemails/{type}          (existence + prior body)
 *   update: PUT    /customemails/{type}           with the full CustomEmail body
 *   create: POST   /customemails                  with the full CustomEmail body (includes `type`)
 *
 * Because `type` IS the path segment, there is no rename-safety concern the way
 * other JumpCloud config types need it — the identity can never change without
 * becoming a different item.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractCustomEmailSpecs(ctx.canvas).filter((s) => s.type)
  const previousState: CustomEmailRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getCustomEmailByType(client, spec.type)
      const body = buildCustomEmailBody(spec)

      if (existing) {
        previousState.push({ type: spec.type, existed: true, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/customemails/${encodeURIComponent(spec.type)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Custom Email "${spec.type}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/customemails', { body })
        if (!res.ok) throw new Error(`Failed to create Custom Email "${spec.type}": ${jumpCloudErrorMessage(res)}`)
        previousState.push({ type: spec.type, existed: false })
      }

      applied.push(spec.type)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Custom Email override(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom Email deploy failed after ${applied.length} of ${specs.length} override(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Fetch a Custom Email override by type, or null on 404 / any non-ok. */
export async function getCustomEmailByType(client: JumpCloudClient, type: string): Promise<JumpCloudCustomEmail | null> {
  const res = await client.request('GET', `/customemails/${encodeURIComponent(type)}`)
  if (!res.ok) return null
  return parseJson<JumpCloudCustomEmail>(res.body)
}
