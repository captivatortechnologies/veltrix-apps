import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractRecipientSpecs, recipientKey, RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE, type LiveRecipient, type RecipientSpec } from './validate'

export interface RecipientRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveRecipient
}

/**
 * Deploy SentinelOne notification recipients via the Management API
 * (`/settings/recipients` — who receives SentinelOne alert notifications).
 *
 * Identity is the recipient `email` at the configured scope: list
 * /settings/recipients, match on the (case-insensitive) email, then PUT an
 * existing recipient or POST a new one. Scope is carried in the request body's
 * `filter`, and an existing recipient's id is carried inside `data` — the same
 * request shape this app already uses for /exclusions. Only account/site/global
 * scopes are supported (the recipients endpoint has no groupIds filter).
 *
 * Source: Celerium/SentinelOne-PowerShellWrapper
 * `Get-SentinelOneSettingEmailRecipients` (GET /settings/recipients; fields
 * email/name/sms; accountIds/siteIds scope only).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }
  if (client.currentScope === 'group') return { success: false, message: RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE }

  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? MISSING_SCOPE_MESSAGE }
  const filter = sf.filter

  const specs = extractRecipientSpecs(ctx.canvas).filter((s) => s.email)
  const rollbackState: RecipientRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listRecipients(client)
    const byKey = new Map(existing.filter((r) => r.email).map((r) => [recipientKey(r.email as string), r]))

    for (const spec of specs) {
      const label = spec.email
      const key = recipientKey(spec.email)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', '/settings/recipients', {
          body: { filter, data: { id: live.id, ...buildData(spec) } },
        })
        if (!res.ok) throw new Error(`Failed to update recipient "${label}": ${s1ErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/settings/recipients', { body: { filter, data: buildData(spec) } })
        if (!res.ok) throw new Error(`Failed to create recipient "${label}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveRecipient | LiveRecipient[]>(res))
        if (!created?.id) throw new Error(`Recipient "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} notification recipient(s) to ${consoleUrl} (${client.currentScope} scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedRecipients: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification recipient deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedRecipients: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all notification recipients at the configured scope; throws on a non-OK response. */
export async function listRecipients(client: S1Client): Promise<LiveRecipient[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveRecipient>('/settings/recipients', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list notification recipients: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** POST /settings/recipients may return the created object or an array; normalize to the first. */
function firstResult(result: LiveRecipient | LiveRecipient[] | null): LiveRecipient | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}

function buildData(spec: RecipientSpec): Record<string, unknown> {
  return {
    email: spec.email,
    name: spec.name ?? '',
    sms: spec.sms ?? '',
  }
}
