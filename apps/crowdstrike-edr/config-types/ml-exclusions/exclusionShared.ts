// =============================================================================
// Helpers shared across the three exclusion config types (ml/ioa/sv).
//
// Lives inside ml-exclusions and is imported by the ioa/sv handlers so the
// exclusion family stays DRY without adding to config-types/lib. Everything
// here is exclusion-specific behaviour verified against the Falcon exclusion
// APIs — the generic transport lives in lib/exclusionAdapter.
// =============================================================================

import type { HealthCheckResult } from '@veltrixsecops/app-sdk'
import type { LiveExclusion } from '../../lib/exclusionAdapter'
import type { ModifiedResource } from '../lib/crowdstrikeAudit'

export const DEPLOY_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'
export const ROLLBACK_COMMENT = 'Rollback by Veltrix (crowdstrike-edr app)'

/**
 * Host-group targeting the exclusion write API expects. There is no
 * `applied_globally` write field — the sentinel ["all"] tells Falcon to apply
 * the exclusion to every host (the API then reports applied_globally:true and an
 * empty groups array on read).
 */
export function resolveDeployGroups(appliedGlobally: boolean, hostGroups: string[]): string[] {
  return appliedGlobally ? ['all'] : hostGroups
}

/**
 * Map a live exclusion's modifier fields onto the shape crowdstrikeAudit reads.
 * Exclusions record their last writer as `modified_by` and the time as
 * `last_modified`; the audit picker looks for `modified_on`, so bridge them here
 * to surface both who and when on a drifted diff.
 */
export function exclusionActorResource(live: LiveExclusion): ModifiedResource {
  return { modified_by: live.modified_by, modified_on: live.last_modified }
}

/** Read a live exclusion field that Falcon returns as a string (or absent). */
export function liveString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Read a live exclusion field Falcon returns as a string array (or absent). */
export function liveStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/** Run a named health check, timing it and never throwing. */
export async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
