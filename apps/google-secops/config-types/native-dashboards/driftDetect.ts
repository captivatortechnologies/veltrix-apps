import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractNativeDashboardSpecs } from './validate'
import { listDashboards } from './deploy'

type Diffs = DriftResult['diffs']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Object keys sorted recursively; array element order is preserved (significant). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

/** Stable string form of the filters array, immune to key-order drift. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? []))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listDashboards(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.dashboards.map((d) => [d.displayName ?? '', d]))

  const specs = extractNativeDashboardSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.displayName}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.access ?? 'DASHBOARD_PRIVATE') !== spec.access) {
      diffs.push({ field: `${spec.displayName}.access`, expected: spec.access, actual: live.access ?? 'DASHBOARD_PRIVATE', severity: 'warning' })
    }
    if ((live.dashboardUserData?.isPinned ?? false) !== spec.isPinned) {
      diffs.push({ field: `${spec.displayName}.isPinned`, expected: String(spec.isPinned), actual: String(live.dashboardUserData?.isPinned ?? false), severity: 'warning' })
    }
    const liveFilters = stableStringify(live.definition?.filters ?? [])
    const specFilters = stableStringify(spec.filters ?? [])
    if (liveFilters !== specFilters) {
      diffs.push({ field: `${spec.displayName}.filters`, expected: specFilters, actual: liveFilters, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
