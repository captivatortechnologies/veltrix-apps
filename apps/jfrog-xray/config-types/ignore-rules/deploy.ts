import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, type XrayClient } from '../../lib/xrayApi'
import { bodiesEqual, buildIgnoreRuleBody, extractIgnoreRuleSpecs, type IgnoreRuleBody } from './_shared'

export const IGNORE_RULES_PATH = '/api/v1/ignore_rules'
export const ignoreRulePath = (id: string): string => `${IGNORE_RULES_PATH}/${encodeURIComponent(id)}`

/**
 * One canvas item's outcome for this deploy. `action` records what actually
 * happened so rollback (and the next deploy's diffing) know exactly how to
 * reverse it:
 *   - "unchanged": the declared content matched what was already live — no API
 *     call made (Xray's rules are immutable; recreating an identical rule
 *     would only churn its id/created timestamp for no benefit).
 *   - "created":   a brand-new rule (no prior tracked state, or the prior
 *     tracked rule had been deleted out-of-band).
 *   - "replaced":  content changed — the OLD rule was deleted and a NEW one
 *     created (Xray has no update endpoint; see module header).
 *   - "removed":   the canvas item was deleted; its rule was deleted too.
 */
export interface IgnoreRuleEntry {
  itemId: string
  action: 'unchanged' | 'created' | 'replaced' | 'removed'
  /** The rule id now live in Xray after this deploy. Empty for "removed". */
  ruleId: string
  /** The body now live in Xray after this deploy (for the NEXT deploy's diffing). Absent for "removed". */
  body?: IgnoreRuleBody
  /** What existed BEFORE this deploy for this item — set for "replaced" and "removed", used by rollback. */
  previous?: { ruleId: string; body: IgnoreRuleBody }
}

interface CreateIgnoreRuleResponse {
  info?: string
}

/**
 * Deploy JFrog Xray ignore rules over the Xray REST API v1:
 *   create: POST   /api/v1/ignore_rules       → 201, `{"info":"...id: <uuid>"}` (the id is
 *                                                embedded in the message — Xray has no separate
 *                                                `id` field or Location header on this response)
 *   delete: DELETE /api/v1/ignore_rules/{id}  → 204 No Content (soft-delete)
 *   (there is NO update/PUT endpoint for ignore rules — verified against the official reference
 *    index: only create/get-all/get-one/delete pages exist)
 * Docs:
 *   https://docs.jfrog.com/security/reference/create-ignore-rule
 *   https://docs.jfrog.com/security/reference/get-ignore-rules
 *   https://docs.jfrog.com/security/reference/get-ignore-rule
 *   https://docs.jfrog.com/security/reference/delete-ignore-rule
 *
 * An ignore rule has NO user-chosen name, so this reconciles by the CANVAS
 * ITEM's own stable id (`item.id`), read from the last successful
 * deployment's rollbackData — the SDK-documented pattern for a target whose
 * server assigns an opaque id per canvas item (see
 * PlatformDataApi.getLatestDeployment / DeploymentSummary.rollbackData).
 * Because there is no update endpoint, a content change deletes the old rule
 * and creates a new one instead of a PUT.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractIgnoreRuleSpecs(ctx.canvas).filter((s) => s.notes && s.itemId)
  const priorEntries = await loadPriorEntries(ctx)
  const priorByItem = new Map(priorEntries.filter((e) => e.itemId).map((e) => [e.itemId, e]))

  const entries: IgnoreRuleEntry[] = []
  let created = 0
  let replaced = 0
  let removed = 0

  try {
    for (const spec of specs) {
      const itemId = spec.itemId as string
      const desired = buildIgnoreRuleBody(spec)
      const prior = priorByItem.get(itemId)
      const priorStillLive = prior && prior.ruleId ? await ruleExists(client, prior.ruleId) : false

      if (prior && priorStillLive && prior.body && bodiesEqual(prior.body, desired)) {
        entries.push({ itemId, action: 'unchanged', ruleId: prior.ruleId, body: prior.body })
        continue
      }

      if (prior && priorStillLive) {
        const delRes = await client.deleteResource(ignoreRulePath(prior.ruleId))
        if (!delRes.ok && delRes.status !== 404) {
          throw new Error(`Failed to delete the prior ignore rule for "${spec.notes}" (${prior.ruleId}): HTTP ${delRes.status}`)
        }
        const newId = await createRule(client, desired, spec.notes)
        entries.push({ itemId, action: 'replaced', ruleId: newId, body: desired, previous: { ruleId: prior.ruleId, body: prior.body ?? desired } })
        replaced++
        continue
      }

      const newId = await createRule(client, desired, spec.notes)
      entries.push({ itemId, action: 'created', ruleId: newId, body: desired })
      created++
    }

    // Reconcile: delete rules for canvas items that are no longer declared.
    const declaredIds = new Set(specs.map((s) => s.itemId as string))
    for (const prior of priorEntries) {
      if (!prior.itemId || declaredIds.has(prior.itemId) || !prior.ruleId || !prior.body) continue
      const delRes = await client.deleteResource(ignoreRulePath(prior.ruleId))
      if (!delRes.ok && delRes.status !== 404) {
        throw new Error(`Failed to delete the removed ignore rule (${prior.ruleId}): HTTP ${delRes.status}`)
      }
      entries.push({ itemId: prior.itemId, action: 'removed', ruleId: '', previous: { ruleId: prior.ruleId, body: prior.body } })
      removed++
    }

    return {
      success: true,
      message: `Deployed ${specs.length} Xray ignore rule(s) to ${host}: ${created} created, ${replaced} replaced, ${removed} removed, ${entries.length - created - replaced - removed} unchanged`,
      artifacts: { host },
      rollbackData: { entries },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray ignore-rule deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { host },
      rollbackData: { entries },
    }
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<IgnoreRuleEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: IgnoreRuleEntry[] } | undefined
    return Array.isArray(data?.entries) ? data!.entries : []
  } catch {
    return []
  }
}

async function ruleExists(client: XrayClient, ruleId: string): Promise<boolean> {
  const res = await client.request('GET', ignoreRulePath(ruleId))
  return res.ok
}

/**
 * Create a rule and recover its server-assigned id from the `info` message —
 * Xray's create response has no separate `id` field (see module header).
 */
async function createRule(client: XrayClient, body: IgnoreRuleBody, label: string): Promise<string> {
  const res = await client.request('POST', IGNORE_RULES_PATH, body)
  if (!res.status || res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to create ignore rule "${label}": HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  const parsed = safeParse<CreateIgnoreRuleResponse>(res.body)
  const match = parsed?.info ? /id:\s*([^\s"]+)/i.exec(parsed.info) : null
  const id = match?.[1]
  if (!id) {
    throw new Error(`Ignore rule "${label}" was created but Xray's response did not include a recoverable id: ${res.body.slice(0, 300)}`)
  }
  return id
}

function safeParse<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}
