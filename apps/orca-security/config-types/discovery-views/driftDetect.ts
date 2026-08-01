import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { canonicalJson, dataFromEnvelope, normalizeBool, parseJsonField, priorServerId, readPriorRollback } from '../../lib/reconcile'
import { type OrcaDiscoveryView } from './_shared'

/**
 * Drift for discovery views: for each declared item recover the preference id
 * this canvas assigned (from its own prior deploy's rollbackData), GET the live
 * view and compare the managed fields (view type, org-level flag, the Discovery
 * query and extra params) against what we declare. Best-effort — an item with no
 * known id, or a view that can't be read, is skipped. The query and extra params
 * are compared as canonical JSON. Read-only: GET /api/user_preferences/{id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaDiscoveryView>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.name ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readDiscoveryView(client, knownId)
    if (!live) continue

    const expectedViewType = String(item.fields.viewType ?? '').trim() || 'discovery'
    compare(diffs, name, 'viewType', expectedViewType, String(live.view_type ?? '').trim() || 'discovery')
    compare(diffs, name, 'organizationLevel', normalizeBool(item.fields.organizationLevel, true), normalizeBool(live.organization_level, true))

    const query = parseJsonField(item.fields.query, 'Discovery query')
    if (query.ok) {
      compare(diffs, name, 'query', canonicalJson(query.value), canonicalJson(live.filter_data?.query2))
    }

    const rawExtra = typeof item.fields.extraParams === 'string' ? item.fields.extraParams.trim() : ''
    if (rawExtra) {
      const extra = parseJsonField(item.fields.extraParams, 'Extra params')
      if (extra.ok) {
        compare(diffs, name, 'extraParams', canonicalJson(extra.value), canonicalJson(live.extra_params ?? {}))
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readDiscoveryView(client: OrcaClient, id: string): Promise<OrcaDiscoveryView | null> {
  const res = await client.request<unknown>('GET', `/api/user_preferences/${encodeURIComponent(id)}`)
  if (res.error) return null
  return dataFromEnvelope<OrcaDiscoveryView>(res.data)
}
