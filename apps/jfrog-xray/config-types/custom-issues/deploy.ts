import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson, xrayErrorMessage } from '../../lib/xrayApi'
import { buildCustomIssueBody, extractCustomIssueSpecs, type XrayCustomIssue } from './_shared'

// GET is v2, POST/PUT/DELETE are v1 — both confirmed independently against the
// official Xray REST API reference (create-issue-event / get-issue-events-v2 /
// update-issue-event / delete-issue-event); this asymmetry is real, not a typo.
export const CUSTOM_ISSUES_CREATE_PATH = '/api/v1/events'
export const customIssueReadPath = (id: string): string => `/api/v2/events/${encodeURIComponent(id)}`
export const customIssueWritePath = (id: string): string => `/api/v1/events/${encodeURIComponent(id)}`

export interface CustomIssueRollbackEntry {
  id: string
  existed: boolean
  /** The full prior issue body (read before the PUT) — used to restore an updated issue on rollback. */
  prior?: XrayCustomIssue
}

/**
 * Deploy JFrog Xray custom issues over the Xray REST API:
 *   read (identity + rollback): GET  /api/v2/events/{id}   → does this id already exist?
 *   create:                     POST /api/v1/events         with the full issue body (includes id)
 *   update:                     PUT  /api/v1/events/{id}    with the full issue body (full replace)
 * Upserts by the USER-CHOSEN `id` (Xray assigns no id of its own for this object — unlike
 * ignore-rules). rollbackData records, per issue, whether it existed and (when it did) its full
 * prior body, so rollback can either delete what we created or PUT the exact prior state back.
 *
 * Docs:
 *   https://docs.jfrog.com/security/reference/create-issue-event
 *   https://docs.jfrog.com/security/reference/get-issue-events-v2_custom-issues-v2-openapi
 *   https://docs.jfrog.com/security/reference/update-issue-event
 *   https://docs.jfrog.com/security/reference/delete-issue-event
 * Cross-checked against JFrog's own Terraform provider for the conceptual schema
 * (with two confirmed wire-format discrepancies resolved in favor of the literal
 * REST example — see config-types/custom-issues/_shared.ts header):
 *   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/custom_issue.md
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractCustomIssueSpecs(ctx.canvas).filter((s) => s.id)
  const rollbackState: CustomIssueRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const desired = buildCustomIssueBody(spec)
      const getRes = await client.request('GET', customIssueReadPath(spec.id))

      if (getRes.ok) {
        const prior = parseJson<XrayCustomIssue>(getRes.body) ?? ({ id: spec.id } as XrayCustomIssue)
        rollbackState.push({ id: spec.id, existed: true, prior })
        const putRes = await client.request('PUT', customIssueWritePath(spec.id), desired)
        if (!putRes.ok) throw new Error(`Failed to update custom issue "${spec.id}": HTTP ${putRes.status}: ${xrayErrorMessage(putRes)}`)
      } else {
        rollbackState.push({ id: spec.id, existed: false })
        const postRes = await client.request('POST', CUSTOM_ISSUES_CREATE_PATH, desired)
        if (!postRes.ok) throw new Error(`Failed to create custom issue "${spec.id}": HTTP ${postRes.status}: ${xrayErrorMessage(postRes)}`)
      }
      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Xray custom issue(s) to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedIssues: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray custom-issue deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { host, deployedIssues: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}
