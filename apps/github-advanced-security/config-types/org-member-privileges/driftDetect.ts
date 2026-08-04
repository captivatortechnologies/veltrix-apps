import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, buildOrgPatch, type OrgMemberPrivileges } from './_shared'

/**
 * Drift for org member privileges: compare each declared organization's
 * settings against its live state. Read-only — GET /orgs/{org}. Best-effort:
 * an org that can't be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org) continue

    const res = await client.getOrg(desired.org)
    if (!res.ok) continue // best-effort: can't read the org, assert no drift
    const live = parseJson<OrgMemberPrivileges>(res.body) ?? {}
    const body = buildOrgPatch(desired)

    for (const [key, value] of Object.entries(body)) {
      const actual = (live as Record<string, unknown>)[key]
      if (String(actual ?? '') !== String(value ?? '')) {
        diffs.push({ field: `${desired.org}.${key}`, expected: value, actual: actual ?? null, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
