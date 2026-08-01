import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { canonicalJson, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import { normalizeStatus, readAutomation, type OrcaAutomation } from './_shared'
import { normalizeStringList } from '../../lib/reconcile'

/**
 * Drift for automations: for each declared item recover the automation id this
 * canvas assigned (from its own prior deploy's rollbackData), GET the live
 * automation and compare the managed fields (status, description, business
 * units, the Sonar query and the action list) against what we declare.
 * Best-effort — an item with no known id, or one that can't be read, is skipped.
 * The Sonar query and actions are compared as canonical JSON. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaAutomation>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readAutomation(client, knownId)
    if (!live) continue

    compare(diffs, name, 'status', normalizeStatus(item.fields.status), normalizeStatus(live.status))
    compare(diffs, name, 'description', String(item.fields.description ?? '').trim(), String(live.description ?? '').trim())

    const expectedUnits = normalizeStringList(item.fields.businessUnits)
    const liveUnits = Array.isArray(live.business_units) ? live.business_units.map((v) => String(v)) : []
    if ([...expectedUnits].sort().join('\n') !== [...liveUnits].sort().join('\n')) {
      diffs.push({ field: `${name}.businessUnits`, expected: expectedUnits, actual: liveUnits, severity: 'warning' })
    }

    const query = parseJsonField(item.fields.sonarQuery, 'Sonar query')
    if (query.ok) {
      compare(diffs, name, 'sonarQuery', canonicalJson(query.value), canonicalJson(live.filter?.sonar_query))
    }

    const actions = parseJsonField(item.fields.actions, 'Actions')
    if (actions.ok) {
      compare(diffs, name, 'actions', canonicalJson(actions.value), canonicalJson(live.actions ?? []))
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}
