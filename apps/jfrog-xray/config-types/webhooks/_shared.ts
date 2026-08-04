// =============================================================================
// Shared types + helpers for the JFrog Xray Webhooks config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray webhook body the same way.
//
// A webhook is a named HTTP callback target — reconciled by NAME, same upsert
// shape as policies/watches. Verified against JFrog's own Terraform provider
// (the wire endpoint has no dedicated docs.jfrog.com reference page; see
// config-types/webhooks/deploy.ts header for the full citation trail,
// including confirmation straight from the provider's Go source).
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { readBool, readKeyValueMap, readOptionalString, readString } from '../../lib/fields'

// --- Xray webhook wire shape -----------------------------------------------------

export interface XrayWebhook {
  name: string
  description?: string
  url: string
  user_name?: string
  password?: string
  use_proxy?: boolean
  headers?: Record<string, string>
}

// --- Canvas spec extraction ----------------------------------------------------

export interface WebhookSpec {
  itemLabel: string
  name: string
  description?: string
  url: string
  userName?: string
  password?: string
  useProxy: boolean
  headers: Record<string, string>
}

/** Read every canvas item as a `WebhookSpec`. Tolerates the `items`/`sections` alias. */
export function extractWebhookSpecs(canvas: CanvasSnapshot): WebhookSpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemLabel: item.name || readString(f.name) || '(unnamed)',
      name: readString(f.name),
      description: readOptionalString(f.description),
      url: readString(f.url),
      userName: readOptionalString(f.user_name),
      password: readOptionalString(f.password),
      useProxy: readBool(f.use_proxy, false),
      headers: readKeyValueMap(f.headers),
    }
  })
}

/** The webhook's logical identity: its name. Xray webhook names are case-sensitive (they're a URL path segment). */
export function webhookKey(name: string): string {
  return name.trim()
}

/** Find a live webhook by name (exact match). */
export function findWebhook(webhooks: XrayWebhook[], name: string): XrayWebhook | undefined {
  const key = webhookKey(name)
  return webhooks.find((w) => webhookKey(w.name ?? '') === key)
}

/** The full create/update body. A blank password is omitted (never sent as an empty-string secret). */
export function buildWebhookBody(spec: WebhookSpec): XrayWebhook {
  const body: XrayWebhook = { name: spec.name, url: spec.url, use_proxy: spec.useProxy }
  if (spec.description) body.description = spec.description
  if (spec.userName) body.user_name = spec.userName
  if (spec.password) body.password = spec.password
  if (Object.keys(spec.headers).length > 0) body.headers = spec.headers
  return body
}
