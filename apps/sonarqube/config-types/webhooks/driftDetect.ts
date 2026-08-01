import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { webhooksFromList, findWebhook, scopeOf, type SonarWebhook } from './_shared'

/**
 * Drift for webhooks: compare presence and delivery URL against the live webhook in
 * SonarQube; when the canvas declares a secret, verify the live webhook reports one
 * (`hasSecret`). Best-effort — a scope that can't be listed is skipped rather than raising
 * false drift. Read-only:
 *   GET /api/webhooks/list[?project=..]  → live webhooks (key, name, url, hasSecret)
 *
 * NOTE: SonarQube never returns the secret value, so only its presence can be compared.
 */
const enc = encodeURIComponent

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const listCache = new Map<string, SonarWebhook[] | null>()
  async function list(project: string): Promise<SonarWebhook[] | null> {
    if (listCache.has(project)) return listCache.get(project)!
    const suffix = project ? `?project=${enc(project)}` : ''
    try {
      const webhooks = webhooksFromList(await getJson<unknown>(`${base}/api/webhooks/list${suffix}`, headers))
      listCache.set(project, webhooks)
      return webhooks
    } catch {
      listCache.set(project, null)
      return null
    }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    if (!name) continue

    const project = scopeOf(item.fields.project)
    const live = await list(project)
    if (!live) continue

    const label = project ? `${name} (project ${project})` : `${name} (global)`
    const match = findWebhook(live, name)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (url && String(match.url ?? '') !== url) {
      diffs.push({ field: `${label}.url`, expected: url, actual: String(match.url ?? ''), severity: 'warning' })
    }

    const wantSecret = String(item.fields.secret ?? '').trim() !== ''
    if (wantSecret && match.hasSecret !== true) {
      diffs.push({ field: `${label}.secret`, expected: 'set', actual: 'absent', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
