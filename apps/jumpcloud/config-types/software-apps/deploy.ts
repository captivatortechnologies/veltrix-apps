import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractSoftwareAppSpecs,
  buildSoftwareAppBody,
  findSoftwareAppByName,
  priorFieldsOf,
  type JumpCloudSoftwareApp,
} from './_shared'

/** One rollback record per applied Software App. */
export interface SoftwareAppRollbackEntry {
  displayName: string
  /** Whether the app already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud (catalog-based) Software Apps over the API v2 (/softwareapps):
 *   list:   GET  /softwareapps                     (paged; match candidates by displayName)
 *   update: PUT  /softwareapps/{id}  with { displayName, settings: [one entry] }
 *   create: POST /softwareapps       with { displayName, settings: [one entry] }
 *
 * The displayName is the stable identity used to upsert. Matching is
 * RENAME-SAFE via the per-item resourceIds map (same pattern as the other
 * JumpCloud config types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractSoftwareAppSpecs(ctx.canvas).filter((s) => s.displayName)
  const previousState: SoftwareAppRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveApps = await listSoftwareApps(client)

    for (const spec of specs) {
      let existing: JumpCloudSoftwareApp | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getSoftwareAppById(client, priorId)
      if (!existing) existing = findSoftwareAppByName(liveApps, spec.displayName)

      const body = buildSoftwareAppBody(spec)
      let appId: string

      if (existing?.id) {
        appId = existing.id
        previousState.push({ displayName: spec.displayName, existed: true, id: appId, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/softwareapps/${encodeURIComponent(appId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Software App "${spec.displayName}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/softwareapps', { body })
        if (!res.ok) throw new Error(`Failed to create Software App "${spec.displayName}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudSoftwareApp>(res.body)
        if (!created?.id) throw new Error(`Software App "${spec.displayName}" was created but the API returned no id`)
        appId = created.id
        createdIds.push(appId)
        previousState.push({ displayName: spec.displayName, existed: false, id: appId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = appId
      applied.push(spec.displayName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Software App(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Software App deploy failed after ${applied.length} of ${specs.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every Software App in the org, following pagination. */
export async function listSoftwareApps(client: JumpCloudClient): Promise<JumpCloudSoftwareApp[]> {
  const res = await client.listAll<JumpCloudSoftwareApp>('/softwareapps')
  if (!res.ok) {
    throw new Error(`Failed to list Software Apps: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a Software App by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getSoftwareAppById(client: JumpCloudClient, id: string): Promise<JumpCloudSoftwareApp | null> {
  const res = await client.request('GET', `/softwareapps/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const app = parseJson<JumpCloudSoftwareApp>(res.body)
  return app?.id ? app : null
}

/**
 * Read the canvas-item-id -> app-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
