import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { webhooksFromList, findWebhook, scopeOf, type SonarWebhook } from './_shared'

/**
 * Deploy SonarQube webhooks over the Web API (/api/webhooks):
 *   list (context):  GET  /api/webhooks/list[?project=..]  → find the webhook by name
 *   create:          POST /api/webhooks/create             { name, url, project?, secret? }
 *   update:          POST /api/webhooks/update             { webhook, name, url, secret? }
 *
 * The webhook NAME (within its scope) is the identity used to upsert; SonarQube's opaque
 * `key` is resolved from the list at deploy time. rollbackData records, per webhook, its
 * scope, whether it existed, its key and prior url — so rollback can restore the prior url
 * or delete a webhook we created.
 *
 * NOTE: an empty secret is not sent (the form-encoder drops blanks), so a secret is only
 * set/updated, never cleared, and its value is never read back from SonarQube.
 */
interface CreateResponse {
  webhook?: SonarWebhook
}

const enc = encodeURIComponent

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for webhook deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const listCache = new Map<string, SonarWebhook[]>()
  async function list(project: string): Promise<SonarWebhook[]> {
    if (listCache.has(project)) return listCache.get(project)!
    const suffix = project ? `?project=${enc(project)}` : ''
    let webhooks: SonarWebhook[] = []
    try {
      webhooks = webhooksFromList(await getJson<unknown>(`${base}/api/webhooks/list${suffix}`, headers))
    } catch {
      webhooks = []
    }
    listCache.set(project, webhooks)
    return webhooks
  }

  const webhooks: Array<{ name: string; project: string; existed: boolean; key: string; priorUrl: string; priorHadSecret: boolean }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const url = String(item.fields.url ?? '').trim()
      if (!name || !url) continue

      const project = scopeOf(item.fields.project)
      const secret = String(item.fields.secret ?? '').trim()

      const existing = findWebhook(await list(project), name)
      const existed = existing != null
      const priorUrl = existing?.url ? String(existing.url) : ''
      const priorHadSecret = existing?.hasSecret === true

      let key = existing?.key ? String(existing.key) : ''
      if (!existed) {
        const created = await postForm<CreateResponse>(`${base}/api/webhooks/create`, headers, { name, url, project: project || undefined, secret: secret || undefined })
        key = created?.webhook?.key ? String(created.webhook.key) : ''
      } else {
        await postForm(`${base}/api/webhooks/update`, headers, { webhook: key, name, url, secret: secret || undefined })
      }

      webhooks.push({ name, project, existed, key, priorUrl, priorHadSecret })
      applied.push(project ? `${name} (project ${project})` : `${name} (global)`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} webhook(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { webhooks },
    }
  } catch (error) {
    return {
      success: false,
      message: `Webhook deploy failed after ${applied.length} webhook(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { webhooks },
    }
  }
}
