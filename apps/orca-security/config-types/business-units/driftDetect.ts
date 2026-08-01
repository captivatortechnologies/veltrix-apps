import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope, priorServerId, readPriorRollback } from '../../lib/reconcile'
import { buildBusinessUnitBody, filterValuesOf, type OrcaBusinessUnit } from './_shared'

/**
 * Drift for business units: for each declared item recover the filter id this
 * canvas assigned (from its own prior deploy's rollbackData), GET the live unit
 * and compare the managed fields (criticality, owner, application, contact
 * emails, deployment stages and the scope filter values) against what we
 * declare. Best-effort — an item with no known id, or a unit that can't be read,
 * is skipped rather than raising false drift. Read-only: GET /api/filters/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaBusinessUnit>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readBusinessUnit(client, knownId)
    if (!live) continue

    const expected = buildBusinessUnitBody(item.fields)

    compare(diffs, name, 'businessCriticality', expected.business_criticality ?? '', String(live.business_criticality ?? ''))
    compare(diffs, name, 'ownerTeam', expected.owner_team ?? '', String(live.owner_team ?? ''))
    compare(diffs, name, 'application', expected.application ?? '', String(live.application ?? ''))
    compareList(diffs, name, 'contactEmails', expected.contact_emails ?? [], live.contact_emails ?? [])
    compareList(diffs, name, 'deploymentStages', expected.deployment_stages ?? [], live.deployment_stages ?? [])
    compareList(diffs, name, 'filterValues', filterValuesOf(expected), filterValuesOf(live))
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

/** Compare two string lists as unordered sets (order is not meaningful here). */
function compareList(diffs: DriftDiff[], label: string, field: string, expected: string[], actual: string[]): void {
  const norm = (list: string[]) => [...list].map((v) => String(v)).sort().join('\n')
  const e = norm(expected)
  const a = norm(actual)
  if (e !== a) {
    diffs.push({ field: `${label}.${field}`, expected: expected, actual: actual, severity: 'warning' })
  }
}

async function readBusinessUnit(client: OrcaClient, id: string): Promise<OrcaBusinessUnit | null> {
  const res = await client.request<unknown>('GET', `/api/filters/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaBusinessUnit>(res.data)
}
