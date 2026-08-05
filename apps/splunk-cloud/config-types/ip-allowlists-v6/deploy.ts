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
import { extractAllowlistV6Specs, normalizeSubnet } from './validate'

export interface AllowlistV6RollbackEntry {
  feature: string
  /** Subnets this deployment added (rollback removes them). */
  added: string[]
  /** Subnets this deployment removed (rollback restores them). */
  removed: string[]
}

/**
 * Deploy IPv6 IP allow lists to a Splunk Cloud stack via the ACS API.
 *
 * For each feature section the handler reconciles declared state:
 *   - GET    /access/{feature}/ipallowlists-v6 — read live subnets
 *   - POST   /access/{feature}/ipallowlists-v6 — add declared subnets not yet live
 *   - DELETE /access/{feature}/ipallowlists-v6 — remove undeclared live subnets,
 *     only when removeUndeclared is enabled and never for the "acs" feature
 *     (lockout protection, same as the v4 type).
 *
 * ACS v6 quirk (Splunk's own `terraform-provider-scp`, docs/resources/
 * ipv6_allowlists.md): "Due to API limitations, user can not update all
 * subnets for a given resource at once. When updating a subnet list, please
 * keep at least one original subnet in the list." A reconcile that would
 * remove every currently-live subnet in one request is therefore capped —
 * one pre-existing subnet is held back and reported, so a second deploy (with
 * nothing left declared for it) finishes the removal.
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

  const specs = extractAllowlistV6Specs(ctx.canvas).filter((s) => s.feature)
  const rollbackState: AllowlistV6RollbackEntry[] = []
  const summary: string[] = []
  const notes: string[] = []

  try {
    for (const spec of specs) {
      const path = `/access/${encodeURIComponent(spec.feature)}/ipallowlists-v6`

      const currentRes = await acsRequest(acs, 'GET', path)
      if (currentRes.status !== 200) {
        throw new Error(
          `Failed to read "${spec.feature}" IPv6 allow list: ${acsErrorMessage(currentRes)}`,
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

      // ACS v6 quirk: cannot replace every live subnet in one request — keep
      // one back so at least one pre-existing subnet always survives the call.
      if (toRemove.length > 0 && toRemove.length === live.length && toAdd.length === 0) {
        const held = toRemove.pop() as string
        notes.push(
          `kept 1 pre-existing subnet ("${held}") on "${spec.feature}" — ACS cannot remove every subnet from an IPv6 allow list in a single request; redeploy to finish removing it`,
        )
      }

      if (toAdd.length > 0) {
        const res = await acsRequest(acs, 'POST', path, { subnets: toAdd })
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(
            `Failed to add subnets to "${spec.feature}" IPv6 allow list: ${acsErrorMessage(res)}`,
          )
        }
      }

      if (toRemove.length > 0) {
        const res = await acsRequest(acs, 'DELETE', path, { subnets: toRemove })
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(
            `Failed to remove subnets from "${spec.feature}" IPv6 allow list: ${acsErrorMessage(res)}`,
          )
        }
      }

      rollbackState.push({ feature: spec.feature, added: toAdd, removed: toRemove })
      summary.push(`${spec.feature}: +${toAdd.length}/-${toRemove.length}`)
    }

    const noteSuffix = notes.length > 0 ? ` — ${notes.join('; ')}` : ''
    return {
      success: true,
      message: `Reconciled ${specs.length} IPv6 allow list(s) on stack "${stack}" (${summary.join(', ')})${noteSuffix}`,
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
      message: `IPv6 allow list deployment to stack "${stack}" failed after ${rollbackState.length} of ${specs.length} feature(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, changes: rollbackState },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
