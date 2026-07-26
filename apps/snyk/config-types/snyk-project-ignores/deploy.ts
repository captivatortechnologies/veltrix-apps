import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, parseJson, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractIgnoreSpecs, ignoreKey, toIgnoreRule, type IgnoreRule } from './validate'

/** One issue's ignore state captured before this deploy, for rollback. */
export interface IgnoreRollbackEntry {
  key: string
  projectId: string
  issueId: string
  /** True when the issue already had an ignore before this deploy. */
  existedBefore: boolean
  /** The issue's prior ignore rules (best-effort reconstruction; empty when none). */
  priorRules: IgnoreRule[]
}

/**
 * Deploy Snyk project ignores via the v1 API.
 *
 * Identity is the (project id, issue id) pair. For each declared ignore, read
 * the issue's current ignore (captured for rollback), then PUT the declared rule
 * — PUT "Replace ignores" makes the issue's ignores exactly the declared set, so
 * the deploy is a declarative, idempotent upsert. There is no secret.
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

  const specs = extractIgnoreSpecs(ctx.canvas).filter((s) => s.projectId && s.issueId)
  const rollbackState: IgnoreRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const priorRules = await readIssueIgnore(client, spec.projectId, spec.issueId)
      rollbackState.push({
        key: ignoreKey(spec.projectId, spec.issueId),
        projectId: spec.projectId,
        issueId: spec.issueId,
        existedBefore: priorRules.length > 0,
        priorRules,
      })

      const res = await client.v1(
        'PUT',
        `${client.v1OrgPath()}/project/${spec.projectId}/ignore/${encodeURIComponent(spec.issueId)}`,
        { body: [toIgnoreRule(spec)] },
      )
      if (!res.ok) {
        throw new Error(`Failed to ignore issue "${spec.issueId}" in project "${spec.projectId}": ${snykErrorMessage(res)}`)
      }
      applied.push(spec.issueId)
    }

    return {
      success: true,
      message: `Snyk project ignores deployed to ${host}: ${applied.length} applied`,
      artifacts: { host, applied },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Ignore deployment failed after ${applied.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, applied },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * GET an issue's current ignore rules. A missing ignore (404) reads as an empty
 * list rather than throwing; any other non-OK status throws. Returns the rules
 * reconstructed defensively from the v1 response.
 */
export async function readIssueIgnore(client: SnykClient, projectId: string, issueId: string): Promise<IgnoreRule[]> {
  const res = await client.v1(
    'GET',
    `${client.v1OrgPath()}/project/${projectId}/ignore/${encodeURIComponent(issueId)}`,
  )
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`Failed to read ignore for issue "${issueId}" in project "${projectId}": ${snykErrorMessage(res)}`)
  }
  return parseLiveIgnoreRules(res.body)
}

/**
 * The v1 ignore representation as returned on GET (each entry is a single-key
 * object keyed by the ignore path).
 */
interface LiveIgnorePathEntry {
  reason?: string
  reasonType?: string
  disregardIfFixable?: boolean
  expires?: string
}

/**
 * Reconstruct ignore rules from a v1 ignore GET response. The per-issue GET
 * returns an array of path-keyed objects
 * (`[{ "*": { reason, reasonType, disregardIfFixable, expires } }]`); the list
 * envelope keys those arrays by issue id. Both are handled defensively so a shape
 * variation degrades to an empty list rather than throwing.
 */
export function parseLiveIgnoreRules(body: string): IgnoreRule[] {
  const parsed = parseJson<unknown>(body)
  if (!parsed) return []

  const pathEntries: Array<Record<string, LiveIgnorePathEntry>> = []
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') pathEntries.push(entry as Record<string, LiveIgnorePathEntry>)
    }
  } else if (typeof parsed === 'object') {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') pathEntries.push(entry as Record<string, LiveIgnorePathEntry>)
        }
      }
    }
  }

  const rules: IgnoreRule[] = []
  for (const entry of pathEntries) {
    for (const [ignorePath, meta] of Object.entries(entry)) {
      if (!meta || typeof meta !== 'object') continue
      rules.push({
        ignorePath: ignorePath || '*',
        ...(meta.reason ? { reason: meta.reason } : {}),
        reasonType: typeof meta.reasonType === 'string' ? meta.reasonType : 'not-vulnerable',
        disregardIfFixable: Boolean(meta.disregardIfFixable),
        ...(meta.expires ? { expires: meta.expires } : {}),
      })
    }
  }
  return rules
}
