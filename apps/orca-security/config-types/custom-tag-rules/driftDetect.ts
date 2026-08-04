import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { canonicalJson, priorServerId, readKeyValueMap, readPriorRollback, stringMapsEqual } from '../../lib/reconcile'
import { buildCustomTagRuleBody, tagRuleFromEnvelope, type OrcaTagRule } from './_shared'

/**
 * Drift for custom tag rules: for each declared item, recover the rule id this
 * canvas assigned, GET the live rule and compare the managed fields
 * (description, disabled, tags and the query) against what we declare.
 * Best-effort — an item with no known id, or a rule that can't be read, is
 * skipped. Read-only: GET /api/custom_tags/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaTagRule>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readTagRule(client, knownId)
    if (!live) continue

    const bodyResult = buildCustomTagRuleBody(item.fields)
    if (!bodyResult.ok) continue
    const expected = bodyResult.body

    compare(diffs, name, 'description', expected.description ?? '', String(live.description ?? '').trim())
    compare(diffs, name, 'disabled', Boolean(expected.disabled), Boolean(live.disabled))
    compare(diffs, name, 'ruleType', expected.rule_type, live.rule_type)
    compare(diffs, name, 'rule', canonicalJson(expected.rule), canonicalJson(live.rule))

    const expectedTags = expected.tags ?? {}
    const liveTags = readKeyValueMap(live.tags)
    if (!stringMapsEqual(expectedTags, liveTags)) {
      diffs.push({ field: `${name}.tags`, expected: expectedTags, actual: liveTags, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readTagRule(client: OrcaClient, id: string): Promise<OrcaTagRule | null> {
  const res = await client.request<unknown>('GET', `/api/custom_tags/${encodeURIComponent(id)}`)
  if (res.error) return null
  return tagRuleFromEnvelope(res.data)
}
