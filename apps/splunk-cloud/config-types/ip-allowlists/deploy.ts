import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractAllowlistSpecs, normalizeSubnet } from './validate'

export interface AllowlistRollbackEntry {
  feature: string
  /** Subnets this deployment added (rollback removes them). */
  added: string[]
  /** Subnets this deployment removed (rollback restores them). */
  removed: string[]
}

/**
 * Deploy IP allow lists to a Splunk Cloud stack via the ACS API.
 *
 * For each feature section the handler reconciles declared state:
 *   - GET    /access/{feature}/ipallowlists — read live subnets
 *   - POST   /access/{feature}/ipallowlists — add declared subnets not yet live
 *   - DELETE /access/{feature}/ipallowlists — remove undeclared live subnets,
 *     only when removeUndeclared is enabled and never for the "acs" feature
 *     (lockout protection).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractAllowlistSpecs(ctx.canvas).filter((s) => s.feature)
  const rollbackState: AllowlistRollbackEntry[] = []
  const summary: string[] = []
  const notes: string[] = []

  try {
    for (const spec of specs) {
      const path = `/access/${encodeURIComponent(spec.feature)}/ipallowlists`

      const currentRes = await acsRequest(acs, 'GET', path)
      if (currentRes.status !== 200) {
        throw new Error(
          `Failed to read "${spec.feature}" allow list: ${acsErrorMessage(currentRes)}`,
        )
      }
      const live = (parseJson<{ subnets?: string[] }>(currentRes.body)?.subnets ?? []).map(
        normalizeSubnet,
      )

      const desired = spec.subnets
      const toAdd = desired.filter((s) => !live.includes(s))
      let toRemove = spec.removeUndeclared ? live.filter((s) => !desired.includes(s)) : []

      // Lockout protection: never auto-remove subnets from the ACS API's own
      // allow list — losing it would cut off all future deployments.
      if (spec.feature === 'acs' && toRemove.length > 0) {
        notes.push(
          `skipped removing ${toRemove.length} undeclared subnet(s) from "acs" (lockout protection)`,
        )
        toRemove = []
      }

      if (toAdd.length > 0) {
        const res = await acsRequest(acs, 'POST', path, { subnets: toAdd })
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(
            `Failed to add subnets to "${spec.feature}" allow list: ${acsErrorMessage(res)}`,
          )
        }
      }

      if (toRemove.length > 0) {
        const res = await acsRequest(acs, 'DELETE', path, { subnets: toRemove })
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(
            `Failed to remove subnets from "${spec.feature}" allow list: ${acsErrorMessage(res)}`,
          )
        }
      }

      rollbackState.push({ feature: spec.feature, added: toAdd, removed: toRemove })
      summary.push(`${spec.feature}: +${toAdd.length}/-${toRemove.length}`)
    }

    const noteSuffix = notes.length > 0 ? ` — ${notes.join('; ')}` : ''
    return {
      success: true,
      message: `Reconciled ${specs.length} allow list(s) on stack "${stack}" (${summary.join(', ')})${noteSuffix}`,
      artifacts: {
        stack,
        experience: settings.experience,
        features: specs.map((s) => s.feature),
        changes: rollbackState,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IP allow list deployment to stack "${stack}" failed after ${rollbackState.length} of ${specs.length} feature(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, changes: rollbackState },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
