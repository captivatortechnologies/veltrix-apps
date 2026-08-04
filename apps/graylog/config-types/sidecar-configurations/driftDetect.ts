import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { sidecarConfigSummariesFromList, findSidecarConfigSummary, type GraylogSidecarConfig } from './_shared'

/**
 * Drift for sidecar configurations: compare the color and template we declare
 * against the live configuration in Graylog. The list endpoint only returns a
 * summary (no template), so a matched item's FULL configuration is fetched
 * individually to compare the template body. Best-effort — a configuration
 * that can't be matched is skipped rather than raising false drift. Read-only:
 * GET /api/sidecar/configurations[/{id}].
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let liveSummaries
  try {
    liveSummaries = sidecarConfigSummariesFromList(await getJson<unknown>(`${base}/api/sidecar/configurations`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const summary = findSidecarConfigSummary(liveSummaries, name)
    if (!summary?.id) continue

    const expectedColor = asString(item.fields.color) || '#FF3B2F'
    const actualColor = asString(summary.color)
    if (expectedColor !== actualColor) {
      diffs.push({ field: `${name}.color`, expected: expectedColor, actual: actualColor, severity: 'info' })
    }

    let full: GraylogSidecarConfig | null = null
    try {
      full = await getJson<GraylogSidecarConfig>(`${base}/api/sidecar/configurations/${encodeURIComponent(summary.id)}`, headers)
    } catch {
      full = null
    }
    if (!full) continue

    const expectedTemplate = String(item.fields.template ?? '').trim()
    const actualTemplate = String(full.template ?? '').trim()
    if (expectedTemplate !== actualTemplate) {
      diffs.push({ field: `${name}.template`, expected: expectedTemplate, actual: actualTemplate, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
