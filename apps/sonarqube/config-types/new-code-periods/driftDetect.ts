import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { levelLabel, type NewCodePeriod } from './_shared'

/**
 * Drift for new code periods: compare the declared type/value against the live
 * definition at that level. Best-effort — a level that can't be read is skipped rather
 * than raising false drift. Read-only:
 *   GET /api/new_code_periods/show[?project=..][&branch=..]  → the live definition,
 *   with `inherited: true` when nothing is explicitly overridden at this exact level.
 *
 * `inherited: true` while the canvas declares an explicit type/value is drift (the
 * declared override isn't currently in effect at this level); a live type/value that
 * differs from the declared one is also drift.
 *
 * Verified live against a running SonarQube instance's own `api/webservices` reflection
 * endpoints.
 */
const enc = encodeURIComponent

function showQuery(project: string, branch: string): string {
  const params: string[] = []
  if (project) params.push(`project=${enc(project)}`)
  if (branch) params.push(`branch=${enc(branch)}`)
  return params.length ? `?${params.join('&')}` : ''
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const project = String(item.fields.project ?? '').trim()
    const branch = String(item.fields.branch ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    if (!type) continue

    const label = levelLabel(project, branch)
    let live: NewCodePeriod
    try {
      live = await getJson<NewCodePeriod>(`${base}/api/new_code_periods/show${showQuery(project, branch)}`, headers)
    } catch {
      continue // can't read this level — skip rather than assert drift
    }

    if (live.inherited === true) {
      diffs.push({ field: `${label}.type`, expected: type, actual: '(inherited — no explicit override)', severity: 'warning' })
      continue
    }

    if (String(live.type ?? '') !== type) {
      diffs.push({ field: `${label}.type`, expected: type, actual: String(live.type ?? ''), severity: 'warning' })
    }

    const liveValue = String(live.value ?? '')
    if (value && liveValue !== value) {
      diffs.push({ field: `${label}.value`, expected: value, actual: liveValue, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
