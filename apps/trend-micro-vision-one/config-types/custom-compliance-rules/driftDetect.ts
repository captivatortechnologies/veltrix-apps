import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import { CUSTOM_RULE_ENDPOINTS, extractCustomRuleFields, findRuleByName, rulesFromResponse } from './_shared'

/**
 * Drift for custom rules — only asserted when the live list reads back cleanly.
 * A declared rule that is ABSENT is drift (someone deleted it in the console).
 * For a present rule, riskLevel, provider, service, resourceType and enabled are
 * compared against what we declare — the deeply nested attributes/eventRules are
 * NOT compared here (Vision One may normalize/reorder them server-side in ways
 * that would raise noisy false drift; VERIFY once a live tenant is available).
 * Read-only: GET beta/cloudPosture/customRules.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.getBeta(CUSTOM_RULE_ENDPOINTS.list)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = rulesFromResponse(res.json)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = extractCustomRuleFields(item.fields)
    if (!fields.name) continue
    const match = findRuleByName(live, fields.name)

    if (!match) {
      diffs.push({ field: `${fields.name}.present`, expected: 'true', actual: 'false', severity: 'critical' })
      continue
    }

    if (fields.riskLevel && String(match.riskLevel ?? '') !== fields.riskLevel) {
      diffs.push({ field: `${fields.name}.riskLevel`, expected: fields.riskLevel, actual: String(match.riskLevel ?? ''), severity: 'warning' })
    }
    if (fields.provider && String(match.provider ?? '') !== fields.provider) {
      diffs.push({ field: `${fields.name}.provider`, expected: fields.provider, actual: String(match.provider ?? ''), severity: 'warning' })
    }
    if (fields.service && String(match.service ?? '') !== fields.service) {
      diffs.push({ field: `${fields.name}.service`, expected: fields.service, actual: String(match.service ?? ''), severity: 'warning' })
    }
    if (fields.resourceType && String(match.resourceType ?? '') !== fields.resourceType) {
      diffs.push({ field: `${fields.name}.resourceType`, expected: fields.resourceType, actual: String(match.resourceType ?? ''), severity: 'warning' })
    }
    if (typeof match.enabled === 'boolean' && match.enabled !== fields.enabled) {
      diffs.push({ field: `${fields.name}.enabled`, expected: String(fields.enabled), actual: String(match.enabled), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
