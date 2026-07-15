import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findAuthServerPolicy, listPolicyRules } from './deploy'
import { extractAuthServerPolicySpecs, parseRulesArray, resolveClientInclude, ruleName } from './validate'

/**
 * Detect drift between the deployed authorization-server policy configuration and
 * the live org. Re-finds each declared policy by (authServerId, name) and diffs
 * the MANAGED fields:
 *   - description, client scoping (conditions.clients.include) — critical
 *   - priority (only when authored) — warning (Okta reorders priorities)
 *   - status — warning
 *   - rules — per-name presence — info (kept light)
 *
 * Only the slices this config type manages are compared: the client-include set
 * (not the whole `conditions` object). Server-managed read-only fields
 * (id/created/lastUpdated/system/_links/status) are never compared as body
 * fields. The rule count is NOT diffed — the config type never prunes unmodeled
 * rules (the built-in system default rule lives here too), so extra live rules
 * are not drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuthServerPolicySpecs(ctx.deployedConfig).filter((s) => s.authServerId && s.name)

  for (const spec of specs) {
    const label = `${spec.authServerId}:${spec.name}`
    try {
      const live = await findAuthServerPolicy(client, spec.authServerId, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // description — managed, returned on read.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'critical',
        })
      }

      // client scoping — compare only the include set we manage (default ALL_CLIENTS).
      const expectedClients = [...resolveClientInclude(spec.clientInclude)].sort()
      const liveClients = extractIncludeClients(live.conditions).sort()
      if (stableStringify(expectedClients) !== stableStringify(liveClients)) {
        diffs.push({
          field: `${label}.conditions.clients.include`,
          expected: expectedClients.join(', '),
          actual: liveClients.length ? liveClients.join(', ') : 'not set',
          severity: 'critical',
        })
      }

      // priority — only diffed when authored (Okta assigns/reorders otherwise).
      if (spec.priority !== undefined && Number.isFinite(spec.priority)) {
        const livePriority = typeof live.priority === 'number' ? live.priority : undefined
        if (livePriority !== spec.priority) {
          diffs.push({
            field: `${label}.priority`,
            expected: spec.priority,
            actual: livePriority ?? 'not set',
            severity: 'warning',
          })
        }
      }

      // status — managed via lifecycle; compare separately (warning).
      const desiredStatus = spec.status || 'ACTIVE'
      const liveStatus = (typeof live.status === 'string' ? live.status : '').toUpperCase()
      if (desiredStatus !== liveStatus) {
        diffs.push({
          field: `${label}.status`,
          expected: desiredStatus,
          actual: liveStatus || 'not set',
          severity: 'warning',
        })
      }

      // rules — light: per-name presence only (info). Extra live rules are NOT
      // drift (never pruned; the system default rule lives here too).
      if (spec.rulesJson && live.id) {
        const expectedRules = parseRulesArray(spec.rulesJson) ?? []
        const liveRules = await listPolicyRules(client, spec.authServerId, live.id)
        const liveNames = new Set(liveRules.map((r) => r.name).filter(Boolean))
        for (const rule of expectedRules) {
          const name = ruleName(rule)
          if (name && !liveNames.has(name)) {
            diffs.push({
              field: `${label}.rules.${name}`,
              expected: 'present',
              actual: 'missing',
              severity: 'info',
            })
          }
        }
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Pull conditions.clients.include out of a policy's conditions, or []. */
function extractIncludeClients(conditions: Record<string, unknown> | undefined): string[] {
  const clients = conditions?.clients as Record<string, unknown> | undefined
  const include = clients?.include
  return Array.isArray(include) ? include.map(String) : []
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
