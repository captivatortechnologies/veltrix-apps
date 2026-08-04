import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope, priorServerId, readPriorRollback } from '../../lib/reconcile'
import type { OrcaComplianceFrameworkBody, OrcaComplianceFrameworkReadResponse } from './_shared'

/**
 * Drift for custom compliance frameworks: for each declared item, recover the
 * framework id this canvas assigned, GET the live framework and compare
 * name/description ONLY. Orca's read endpoint never returns section/test data
 * (write-only — see _shared.ts), so sections cannot be drift-checked; this is
 * an honest, documented limitation, not an oversight. Best-effort — an item
 * with no known id, or one that can't be read, is skipped. Read-only:
 * GET /api/compliance/frameworks/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaComplianceFrameworkBody>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readFramework(client, knownId)
    if (!live) continue

    const expectedDescription = String(item.fields.description ?? '').trim()
    compare(diffs, name, 'name', name, String(live.display_name ?? '').trim())
    compare(diffs, name, 'description', expectedDescription, String(live.description ?? '').trim())
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readFramework(client: OrcaClient, id: string): Promise<OrcaComplianceFrameworkReadResponse | null> {
  const res = await client.request<unknown>('GET', `/api/compliance/frameworks/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaComplianceFrameworkReadResponse>(res.data)
}
