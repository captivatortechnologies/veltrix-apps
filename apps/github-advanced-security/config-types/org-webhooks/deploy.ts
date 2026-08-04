import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import { desiredFromItem, buildWebhookBody, findByUrl, type LiveOrgWebhook, type OrgWebhookRollbackEntry } from './_shared'

/**
 * Deploy organization webhooks over the REST API:
 *   list:   GET   /orgs/{org}/hooks                (match by config.url)
 *   create: POST  /orgs/{org}/hooks
 *   update: PATCH /orgs/{org}/hooks/{hook_id}
 *
 * (org, url) is the stable identity. rollbackData records, per webhook, the
 * prior state (existed) so rollback can restore the non-secret fields or
 * delete what this deploy created — GitHub never echoes a webhook's secret
 * back, so it cannot be captured for restoration (see README).
 */

async function listWebhooks(
  client: GithubClient,
  org: string,
): Promise<{ ok: true; webhooks: LiveOrgWebhook[] } | { ok: false; reason: string }> {
  const res = await client.listOrgWebhooks(org)
  if (!res.ok) return { ok: false, reason: `${res.status} ${githubErrorMessage(res)}` }
  const webhooks = parseJson<LiveOrgWebhook[]>(res.body)
  return { ok: true, webhooks: Array.isArray(webhooks) ? webhooks : [] }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const entries: OrgWebhookRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []
  const listCache = new Map<string, LiveOrgWebhook[]>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const fullName = `${desired.org || '(no org)'} · ${desired.url || '(no url)'}`
    if (!desired.org || !desired.url) {
      skipped.push(fullName)
      continue
    }

    if (!listCache.has(desired.org)) {
      const listed = await listWebhooks(client, desired.org)
      if (!listed.ok) {
        skipped.push(`${fullName} (${listed.reason})`)
        continue
      }
      listCache.set(desired.org, listed.webhooks)
    }
    const webhooks = listCache.get(desired.org) ?? []
    const live = findByUrl(webhooks, desired.url)

    try {
      if (live?.id != null) {
        entries.push({ org: desired.org, url: desired.url, existed: true, id: live.id, prior: live })
        const res = await client.updateOrgWebhook(desired.org, live.id, buildWebhookBody(desired))
        if (!res.ok) throw new Error(`update: ${res.status} ${githubErrorMessage(res)}`)
      } else {
        const res = await client.createOrgWebhook(desired.org, buildWebhookBody(desired))
        if (!res.ok) throw new Error(`create: ${res.status} ${githubErrorMessage(res)}`)
        const created = parseJson<LiveOrgWebhook>(res.body)
        entries.push({ org: desired.org, url: desired.url, existed: false, id: created?.id })
        if (created) webhooks.push(created)
      }
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} webhook(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied ${applied.length} org webhook(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
