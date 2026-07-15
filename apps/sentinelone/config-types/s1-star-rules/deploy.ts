import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import {
  extractStarRuleSpecs,
  ruleKey,
  type LiveStarRule,
  type StarRuleSpec,
} from './validate'

export interface StarRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveStarRule
}

/**
 * Deploy SentinelOne STAR custom detection rules via the Management API
 * (scope-filtered collection).
 *
 * Identity is the rule `name` at the configured scope: list
 * /cloud-detection/rules, match on the name, then PUT an existing rule by id or
 * POST a new one. Every rule is written with status "Draft" (queryLang 2.0) and
 * then enabled/disabled to match the desired "Activate" state, so the create and
 * update paths converge on the same activation reconcile. Scope is carried in the
 * request body's `filter`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractStarRuleSpecs(ctx.canvas).filter((s) => s.name && s.s1ql)
  const rollbackState: StarRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listStarRules(client)
    const byName = new Map(
      existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/cloud-detection/rules/${encodeURIComponent(live.id)}`, {
          body: { filter, data: buildData(spec) },
        })
        if (!res.ok) throw new Error(`Failed to update rule "${label}": ${s1ErrorMessage(res)}`)
        await setActivation(client, live.id, spec.activate, label)
      } else {
        const res = await client.request('POST', '/cloud-detection/rules', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create rule "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveStarRule | LiveStarRule[]>(res))
        if (!created?.id) throw new Error(`Rule "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
        if (spec.activate) await setActivation(client, created.id, true, label)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} STAR rule(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `STAR rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all STAR rules at the configured scope; throws on a non-OK response. */
export async function listStarRules(client: S1Client): Promise<LiveStarRule[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveStarRule>('/cloud-detection/rules', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list STAR rules: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * Enable (Active) or disable (Draft) a rule to match the desired activation.
 * Both endpoints target the id via `filter.ids`.
 */
export async function setActivation(
  client: S1Client,
  id: string,
  activate: boolean,
  label: string,
): Promise<void> {
  const path = activate ? '/cloud-detection/rules/enable' : '/cloud-detection/rules/disable'
  const res = await client.request('PUT', path, { body: { filter: { ids: [id] } } })
  if (!res.ok) {
    throw new Error(`Failed to ${activate ? 'enable' : 'disable'} rule "${label}": ${s1ErrorMessage(res)}`)
  }
}

/** POST /cloud-detection/rules may return the created object or an array; normalize to the first. */
function firstResult(result: LiveStarRule | LiveStarRule[] | null): LiveStarRule | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

/** Build the `data` body for a create/update. Rules are always written as Draft. */
function buildData(spec: StarRuleSpec): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    s1ql: spec.s1ql,
    queryType: spec.queryType,
    severity: spec.severity,
    status: 'Draft',
    networkQuarantine: spec.networkQuarantine,
    expirationMode: spec.expirationMode,
    queryLang: '2.0',
  }
  if (spec.expirationMode === 'Temporary' && spec.expiration) data.expiration = spec.expiration
  if (spec.treatAsThreat && spec.treatAsThreat !== 'none') data.treatAsThreat = spec.treatAsThreat
  return data
}
