import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, buildConfigBody, type CodeSecurityConfiguration } from './_shared'

/**
 * Drift for org security configurations: compare each declared configuration's
 * settings against its live state. Read-only — GET the org's configurations and
 * match by name. Best-effort: an org whose configurations can't be listed is
 * skipped rather than raising false drift. Attachment (which repositories) is not
 * compared here — only the configuration's own settings + enforcement.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const listCache = new Map<string, CodeSecurityConfiguration[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.name) continue
    const fullName = `${desired.org}/${desired.name}`

    if (!listCache.has(desired.org)) {
      const res = await client.listCodeSecurityConfigurations(desired.org)
      listCache.set(desired.org, res.ok ? parseJson<CodeSecurityConfiguration[]>(res.body) ?? [] : null)
    }
    const configs = listCache.get(desired.org)
    if (configs == null) continue // can't list — assert no drift

    const live = configs.find((c) => (c.name ?? '') === desired.name)
    if (!live) {
      diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'warning' })
      continue
    }

    // Compare every field the desired body would set (features + enforcement + description).
    const body = buildConfigBody(desired)
    for (const [key, value] of Object.entries(body)) {
      if (key === 'name') continue
      const actual = live[key]
      if (String(actual ?? '') !== String(value ?? '')) {
        diffs.push({ field: `${fullName}.${key}`, expected: value, actual: actual ?? null, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
