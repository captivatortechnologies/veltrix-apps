import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, findByUrl, type LiveOrgWebhook } from './_shared'

/**
 * Drift for organization webhooks: compare each declared webhook's
 * url/content-type/SSL-verification/events/active against its live state.
 * Read-only — GET the org's webhooks and match by URL. Deliberately does NOT
 * compare `secret` — a write-only field GitHub never echoes back, so no
 * meaningful comparison is possible (see README Coverage notes). Best-effort:
 * an org whose webhooks can't be listed is skipped rather than raising false
 * drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const listCache = new Map<string, LiveOrgWebhook[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.url) continue
    const fullName = `${desired.org} · ${desired.url}`

    if (!listCache.has(desired.org)) {
      const res = await client.listOrgWebhooks(desired.org)
      listCache.set(desired.org, res.ok ? parseJson<LiveOrgWebhook[]>(res.body) ?? [] : null)
    }
    const webhooks = listCache.get(desired.org)
    if (webhooks == null) continue

    const live = findByUrl(webhooks, desired.url)
    if (!live) {
      diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'warning' })
      continue
    }

    if ((live.config?.content_type ?? 'json') !== desired.contentType) {
      diffs.push({ field: `${fullName}.content_type`, expected: desired.contentType, actual: live.config?.content_type ?? 'json', severity: 'warning' })
    }
    if ((live.config?.insecure_ssl ?? '0') !== desired.insecureSsl) {
      diffs.push({ field: `${fullName}.insecure_ssl`, expected: desired.insecureSsl, actual: live.config?.insecure_ssl ?? '0', severity: 'warning' })
    }
    if (Boolean(live.active) !== desired.active) {
      diffs.push({ field: `${fullName}.active`, expected: desired.active, actual: Boolean(live.active), severity: 'warning' })
    }
    const liveEvents = [...(live.events ?? [])].sort()
    const desiredEvents = [...desired.events].sort()
    if (JSON.stringify(liveEvents) !== JSON.stringify(desiredEvents)) {
      diffs.push({ field: `${fullName}.events`, expected: desiredEvents, actual: liveEvents, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
