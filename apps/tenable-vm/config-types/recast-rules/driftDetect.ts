import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { buildRuleValue, findRecastRule } from './deploy'
import { extractRecastRuleSpecs, parseFilterObject } from './validate'

/**
 * Detect drift between the deployed recast rule configuration and the live
 * tenant state. Re-finds each declared rule by its rule_name (POST
 * /v1/recast/rules/search) and diffs the managed fields: description,
 * rule_value (action/severity/compliance_result/comment/false_positive), the
 * filter, the expiry, and disabled_details.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRecastRuleSpecs(ctx.deployedConfig).filter(
    (s) => s.name && s.resourceType && s.action && s.filterJson,
  )

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const label = spec.name
    try {
      const live = await findRecastRule(client, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // description — only compared when the canvas manages one.
      if (spec.description !== undefined) {
        const liveDescription = live.description ?? ''
        if (spec.description !== liveDescription) {
          diffs.push({
            field: `${label}.description`,
            expected: spec.description || 'not set',
            actual: liveDescription || 'not set',
            severity: 'info',
          })
        }
      }

      // resource_type — this rule's finding-type target.
      if (spec.resourceType !== (live.resource_type ?? '')) {
        diffs.push({
          field: `${label}.resource_type`,
          expected: spec.resourceType,
          actual: live.resource_type || 'not set',
          severity: 'critical',
        })
      }

      // rule_value — action + the action-specific field (severity or
      // compliance_result) + comment/false_positive, normalized as a whole.
      const expectedRuleValue = normalize(buildRuleValue(spec))
      const actualRuleValue = normalize(live.rule_value ?? {})
      if (expectedRuleValue !== actualRuleValue) {
        diffs.push({
          field: `${label}.rule_value`,
          expected: expectedRuleValue || 'not set',
          actual: actualRuleValue || 'not set',
          severity: 'warning',
        })
      }

      // filter — which findings the rule matches — normalize both sides so key
      // order / whitespace do not read as drift.
      const expectedFilter = normalize(parseFilterObject(spec.filterJson) ?? {})
      const actualFilter = normalize(live.filter ?? {})
      if (expectedFilter !== actualFilter) {
        diffs.push({
          field: `${label}.filter`,
          expected: expectedFilter || 'not set',
          actual: actualFilter || 'not set',
          severity: 'critical',
        })
      }

      const liveExpires = typeof live.expires_at === 'string' ? live.expires_at : ''
      if ((spec.expiresAt ?? '') !== liveExpires) {
        diffs.push({
          field: `${label}.expires_at`,
          expected: spec.expiresAt ?? 'not set',
          actual: liveExpires || 'not set',
          severity: 'info',
        })
      }

      // disabled_details — only compared when the canvas manages it.
      if (spec.disabled !== undefined) {
        const liveDisabled = live.disabled_details?.disabled ?? false
        if (spec.disabled !== liveDisabled) {
          diffs.push({
            field: `${label}.disabled`,
            expected: String(spec.disabled),
            actual: String(liveDisabled),
            severity: 'warning',
          })
        }
      }

      // Attribute every diff this rule produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.rule_id,
        targetName: spec.name,
        excludeActorLogins,
      })
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

/** Canonicalize a value to a stable comparison string. */
function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return stableStringify(value)
  return String(value)
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
