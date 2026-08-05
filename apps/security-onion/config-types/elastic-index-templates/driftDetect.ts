import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, getJson } from '../../lib/soConsole'
import { parseStringList, type IndexTemplateGetResponse } from './_shared'

/**
 * Drift for index templates: compare the index patterns, priority and
 * settings (shards, replicas, attached ILM policy) we declare against the
 * live template on Elasticsearch. `flat_settings=true` keeps the ILM policy
 * key comparable as the flat `index.lifecycle.name` string this app writes
 * (see deploy.ts). Best-effort — a template that can't be read (missing /
 * transient error) is skipped rather than raising false drift. Elasticsearch
 * returns numeric index settings as strings, so shard/replica counts compare
 * as strings.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  for (const item of items) {
    const templateName = String(item.fields.templateName ?? '').trim()
    if (!templateName) continue

    let live: Record<string, unknown> | null = null
    try {
      const res = await getJson<IndexTemplateGetResponse>(`${esUrl}/_index_template/${encodeURIComponent(templateName)}?flat_settings=true`, auth)
      live = res.index_templates?.find((t) => t.name === templateName)?.index_template ?? null
    } catch {
      continue // best-effort: skip a template we can't read
    }
    if (!live) continue

    const liveSettings = (live.template as Record<string, unknown> | undefined)?.settings as Record<string, unknown> | undefined

    const expectedPatterns = [...parseStringList(item.fields.indexPatterns)].sort()
    const livePatterns = Array.isArray(live.index_patterns) ? [...(live.index_patterns as string[])].sort() : []
    if (JSON.stringify(expectedPatterns) !== JSON.stringify(livePatterns)) {
      diffs.push({ field: `${templateName}.indexPatterns`, expected: expectedPatterns, actual: livePatterns, severity: 'warning' })
    }

    const priorityRaw = item.fields.priority
    if (priorityRaw !== undefined && priorityRaw !== null && String(priorityRaw).trim() !== '') {
      const expectedPriority = Number(priorityRaw)
      const livePriority = typeof live.priority === 'number' ? live.priority : Number(live.priority)
      if (livePriority !== expectedPriority) {
        diffs.push({ field: `${templateName}.priority`, expected: expectedPriority, actual: live.priority ?? null, severity: 'warning' })
      }
    }

    const expectedShards = String(Number(item.fields.numberOfShards))
    const liveShards = liveSettings?.number_of_shards !== undefined ? String(liveSettings.number_of_shards) : undefined
    if (liveShards !== undefined && liveShards !== expectedShards) {
      diffs.push({ field: `${templateName}.numberOfShards`, expected: expectedShards, actual: liveShards, severity: 'warning' })
    }

    const expectedReplicas = String(Number(item.fields.numberOfReplicas))
    const liveReplicas = liveSettings?.number_of_replicas !== undefined ? String(liveSettings.number_of_replicas) : undefined
    if (liveReplicas !== undefined && liveReplicas !== expectedReplicas) {
      diffs.push({ field: `${templateName}.numberOfReplicas`, expected: expectedReplicas, actual: liveReplicas, severity: 'warning' })
    }

    const ilmPolicyName = String(item.fields.ilmPolicyName ?? '').trim()
    if (ilmPolicyName) {
      const liveIlm = liveSettings?.['index.lifecycle.name']
      if (liveIlm !== ilmPolicyName) {
        diffs.push({ field: `${templateName}.ilmPolicyName`, expected: ilmPolicyName, actual: (liveIlm as string) ?? null, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
