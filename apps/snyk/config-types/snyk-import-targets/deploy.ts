import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import {
  extractImportTargetSpecs,
  targetDisplayName,
  toRepoTarget,
  type LiveTarget,
} from './validate'

/** One import target requested by this deploy, for rollback. */
export interface ImportTargetRollbackEntry {
  integrationId: string
  displayName: string
  /** True when the target already existed in the org (import was skipped). */
  existed: boolean
  /** The import job status URL returned by the async import (created targets only). */
  jobLocation?: string
}

/**
 * Deploy Snyk import targets via the v1 Import API.
 *
 * Identity is the target (owner/name). List the org's existing targets (REST
 * Targets API) and skip any declared target that already exists, so re-deploys
 * are idempotent. For a new target, POST the import through the configured
 * integration; the import is ASYNCHRONOUS, so the 201 response carries the job
 * status URL in the Location header (captured for the artifact). There is no
 * secret.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractImportTargetSpecs(ctx.canvas).filter((s) => s.integrationId && s.owner && s.name)
  const rollbackState: ImportTargetRollbackEntry[] = []
  const imported: string[] = []
  const skipped: string[] = []

  try {
    const existing = await listTargets(client)
    const byName = new Set(
      existing
        .map((t) => t.attributes?.display_name)
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.toLowerCase()),
    )

    for (const spec of specs) {
      const displayName = targetDisplayName(spec.owner, spec.name)
      if (byName.has(displayName.toLowerCase())) {
        rollbackState.push({ integrationId: spec.integrationId, displayName, existed: true })
        skipped.push(displayName)
        continue
      }

      const body: Record<string, unknown> = { target: toRepoTarget(spec) }
      if (spec.exclusionGlobs !== undefined) body.exclusionGlobs = spec.exclusionGlobs

      const res = await client.v1('POST', `${client.v1OrgPath()}/integrations/${spec.integrationId}/import`, { body })
      if (!res.ok) {
        throw new Error(`Failed to import target "${displayName}": ${snykErrorMessage(res)}`)
      }
      const jobLocation = res.headers?.location
      rollbackState.push({ integrationId: spec.integrationId, displayName, existed: false, jobLocation })
      imported.push(displayName)
    }

    const parts = [`${imported.length} import(s) requested`]
    if (skipped.length) parts.push(`${skipped.length} already present (left unchanged)`)
    return {
      success: true,
      message: `Snyk import targets deployed to ${host}: ${parts.join(', ')}`,
      artifacts: { host, imported, skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Import target deployment failed after ${imported.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, imported, skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all targets for the org (REST Targets API); throws on a non-OK response. */
export async function listTargets(client: SnykClient): Promise<LiveTarget[]> {
  const res = await client.restGetAll<LiveTarget>(`${client.restOrgPath()}/targets`)
  if (!res.ok) {
    throw new Error(
      `Failed to list targets: ${snykErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}
