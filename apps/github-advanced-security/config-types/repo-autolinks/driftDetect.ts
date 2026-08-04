import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, matchesLive, type LiveAutolink } from './_shared'

/**
 * Drift for repository autolinks: compare each declared autolink against its
 * live state. Read-only — list the repository's autolinks and match by
 * key_prefix. Best-effort: a repo that can't be listed is skipped rather than
 * raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const listCache = new Map<string, LiveAutolink[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    if (!parsed || !desired.keyPrefix) continue
    const { owner, repo } = parsed
    const repoKey = `${owner}/${repo}`
    const fullName = `${repoKey} · ${desired.keyPrefix}`

    if (!listCache.has(repoKey)) {
      const res = await client.listAutolinks(owner, repo)
      listCache.set(repoKey, res.ok ? parseJson<LiveAutolink[]>(res.body) ?? [] : null)
    }
    const autolinks = listCache.get(repoKey)
    if (autolinks == null) continue

    const live = autolinks.find((a) => (a.key_prefix ?? '') === desired.keyPrefix)
    if (!live) {
      diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'warning' })
      continue
    }
    if (!matchesLive(desired, live)) {
      diffs.push({
        field: `${fullName}.url_template`,
        expected: desired.urlTemplate,
        actual: live.url_template ?? null,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
