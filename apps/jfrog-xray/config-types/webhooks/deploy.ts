import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, parseJson, xrayErrorMessage } from '../../lib/xrayApi'
import { buildWebhookBody, extractWebhookSpecs, type XrayWebhook } from './_shared'

export const WEBHOOKS_CREATE_PATH = '/api/v1/webhooks'
export const webhookPath = (name: string): string => `${WEBHOOKS_CREATE_PATH}/${encodeURIComponent(name)}`

export interface WebhookRollbackEntry {
  name: string
  existed: boolean
  /** The prior webhook body (read before the PUT) — used to restore an updated webhook on rollback. */
  prior?: XrayWebhook
}

/**
 * Deploy JFrog Xray webhooks over the Xray REST API v1:
 *   read (identity + rollback): GET  /api/v1/webhooks/{name}   → does this name already exist?
 *   create:                     POST /api/v1/webhooks           with the full webhook body
 *   update:                     PUT  /api/v1/webhooks/{name}    with the full webhook body
 * Upserts by NAME. rollbackData records, per webhook, whether it existed and (when it did) its
 * prior body, so rollback can either delete what we created or PUT the prior state back.
 *
 * NOTE on citations: this endpoint has NO dedicated page in the official Xray REST API
 * reference (docs.jfrog.com/security/reference) — searching its full index for "hook"
 * returns zero matches. The endpoint path and schema below are instead confirmed from TWO
 * independent JFrog-authored sources:
 *   - Schema (name, description, url, headers, password, use_proxy, user_name) — JFrog's own
 *     Terraform provider docs:
 *     https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/webhook.md
 *   - The literal wire path (`xray/api/v1/webhooks` create, `xray/api/v1/webhooks/{name}` for
 *     read/update/delete) — read directly from that same provider's Go source
 *     (resource_xray_webhook.go, the WebhooksEndpoint/WebhookEndpoint constants).
 * A read response may not echo back a set `password` (typical secret-masking behavior) — see
 * README Coverage notes on this limitation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractWebhookSpecs(ctx.canvas).filter((s) => s.name && s.url)
  const rollbackState: WebhookRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const desired = buildWebhookBody(spec)
      const getRes = await client.request('GET', webhookPath(spec.name))

      if (getRes.ok) {
        const prior = parseJson<XrayWebhook>(getRes.body) ?? ({ name: spec.name, url: spec.url } as XrayWebhook)
        rollbackState.push({ name: spec.name, existed: true, prior })
        const putRes = await client.request('PUT', webhookPath(spec.name), desired)
        if (!putRes.ok) throw new Error(`Failed to update webhook "${spec.name}": HTTP ${putRes.status}: ${xrayErrorMessage(putRes)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const postRes = await client.request('POST', WEBHOOKS_CREATE_PATH, desired)
        if (!postRes.ok) throw new Error(`Failed to create webhook "${spec.name}": HTTP ${postRes.status}: ${xrayErrorMessage(postRes)}`)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Xray webhook(s) to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedWebhooks: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray webhook deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { host, deployedWebhooks: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}
