import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, parseJson, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractWebhookSpecs, webhookKey, type LiveWebhook } from './validate'

export interface WebhookRollbackEntry {
  url: string
  existed: boolean
  /** Id of a webhook this deploy created (only set when existed === false). */
  createdId?: string
}

/**
 * Deploy Snyk webhooks via the v1 API.
 *
 * Webhooks cannot be updated, so identity is the URL: list the org's webhooks,
 * and POST any declared URL that does not already exist. Existing URLs are left
 * untouched (their secret cannot be rotated through this API). The signing
 * secret is write-only — sent only on create, never captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractWebhookSpecs(ctx.canvas).filter((s) => s.url)
  const rollbackState: WebhookRollbackEntry[] = []
  const created: string[] = []
  const skipped: string[] = []

  try {
    const existing = await listWebhooks(client)
    const byUrl = new Map(existing.filter((w) => w.url).map((w) => [webhookKey(w.url as string), w]))

    for (const spec of specs) {
      const key = webhookKey(spec.url)
      if (byUrl.has(key)) {
        rollbackState.push({ url: spec.url, existed: true })
        skipped.push(spec.url)
        continue
      }

      const res = await client.v1('POST', `${client.v1OrgPath()}/webhooks`, {
        body: { url: spec.url, secret: spec.secret },
      })
      if (!res.ok) throw new Error(`Failed to create webhook "${spec.url}": ${snykErrorMessage(res)}`)
      const body = parseJson<{ id?: string }>(res.body)
      rollbackState.push({ url: spec.url, existed: false, createdId: body?.id })
      created.push(spec.url)
    }

    const parts = [`${created.length} created`]
    if (skipped.length) parts.push(`${skipped.length} already present (left unchanged)`)
    return {
      success: true,
      message: `Snyk webhooks deployed to ${host}: ${parts.join(', ')}`,
      artifacts: { host, created, skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Webhook deployment failed after ${created.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all webhooks for the org; throws on a non-OK response. */
export async function listWebhooks(client: SnykClient): Promise<LiveWebhook[]> {
  const res = await client.v1('GET', `${client.v1OrgPath()}/webhooks`)
  if (!res.ok) {
    throw new Error(`Failed to list webhooks: ${snykErrorMessage(res)}`)
  }
  // The v1 list envelope has varied over time; accept the documented `results`
  // array, a `webhooks` array, or a bare array.
  const body = parseJson<{ results?: LiveWebhook[]; webhooks?: LiveWebhook[] } | LiveWebhook[]>(res.body)
  if (Array.isArray(body)) return body
  if (Array.isArray(body?.results)) return body!.results!
  if (Array.isArray(body?.webhooks)) return body!.webhooks!
  return []
}
