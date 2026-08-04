import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson } from '../../lib/xrayApi'
import { customIssueReadPath } from './deploy'
import { buildComponents, buildCves, buildSources, extractCustomIssueSpecs, type XrayCustomIssue } from './_shared'

/**
 * Detect drift between the last-deployed custom-issue configuration and the
 * live Xray tenant. Re-reads each declared issue by id (`GET
 * /api/v2/events/{id}`) and compares the scalar fields plus the components/
 * CVEs/sources arrays (compared as a whole via canonical JSON — these are
 * small, order-insensitive reference lists, not worth diffing element-by-element).
 * Best-effort and read-only: any transport failure reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCustomIssueSpecs(ctx.deployedConfig).filter((s) => s.id)
  if (specs.length === 0) return { hasDrift: false, diffs }

  for (const spec of specs) {
    const res = await client.request('GET', customIssueReadPath(spec.id))
    if (!res.ok) {
      if (res.status === 404) diffs.push({ field: spec.id, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    const live = parseJson<XrayCustomIssue>(res.body)
    if (!live) continue

    diffScalar(`${spec.id}.summary`, spec.summary, live.summary ?? '', diffs)
    diffScalar(`${spec.id}.description`, spec.description, live.description ?? '', diffs)
    diffScalar(`${spec.id}.severity`, spec.severity, live.severity ?? '', diffs)
    diffScalar(`${spec.id}.type`, spec.type, live.type ?? '', diffs)
    diffScalar(`${spec.id}.package_type`, spec.packageType, live.package_type ?? '', diffs)

    diffCanonical(`${spec.id}.components`, buildComponents(spec), live.components ?? [], diffs)
    diffCanonical(`${spec.id}.cves`, buildCves(spec), live.cves ?? [], diffs)
    diffCanonical(`${spec.id}.sources`, buildSources(spec), live.sources ?? [], diffs)
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffScalar(field: string, desired: string, actual: string, diffs: DriftDiff[]): void {
  if (desired !== actual) {
    diffs.push({ field, expected: desired || '(none)', actual: actual || '(none)', severity: 'warning' })
  }
}

/** Stable JSON stringify (sorted object keys) so key-order alone never registers as drift. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function diffCanonical(field: string, desired: unknown[], actual: unknown[], diffs: DriftDiff[]): void {
  if (canonical(desired) !== canonical(actual)) {
    diffs.push({ field, expected: canonical(desired), actual: canonical(actual), severity: 'warning' })
  }
}
