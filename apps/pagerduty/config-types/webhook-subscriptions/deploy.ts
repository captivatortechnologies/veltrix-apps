import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildWebhookSubscriptionBody,
  extractWebhookSubscriptionSpecs,
  findFilterTargetId,
  findWebhookSubscription,
  parseCustomHeaders,
  parseEvents,
  type LiveWebhookSubscription,
} from './_shared'

/** Per-subscription rollback record captured during deploy. */
export interface WebhookSubscriptionRollbackEntry {
  description: string
  existed: boolean
  id?: string
  prior?: LiveWebhookSubscription
}

/**
 * Deploy PagerDuty webhook subscriptions over the REST API v2:
 *   read (rollback):  GET  /webhook_subscriptions  → find each live subscription by description
 *   resolve filter:   GET  /services or /teams      → filter_target NAME → id (when required)
 *   create:           POST /webhook_subscriptions   with { webhook_subscription: {...} }
 *   update:           PUT  /webhook_subscriptions/{id} with { webhook_subscription: {...} }
 *
 * `description` is the stable identity used to upsert (an app-level convention
 * — see _shared.ts). A service_reference/team_reference filter's target is
 * supplied by name and resolved to an id here; an account_reference filter
 * takes no target. rollbackData records, per subscription, whether it existed
 * and its prior body — so rollback can restore an updated subscription or
 * delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractWebhookSubscriptionSpecs(ctx.canvas).filter((s) => s.description && s.url && s.filterType)
  const rollbackState: WebhookSubscriptionRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listWebhookSubscriptions(client)
    const byDescription = new Map(
      existing.filter((s) => s.description).map((s) => [String(s.description).toLowerCase(), s]),
    )

    const needsServices = specs.some((s) => s.filterType === 'service_reference')
    const needsTeams = specs.some((s) => s.filterType === 'team_reference')
    const services = needsServices ? await listServices(client) : []
    const teams = needsTeams ? await listTeams(client) : []

    for (const spec of specs) {
      const eventsParsed = parseEvents(spec.eventsJson)
      if (eventsParsed.error || !eventsParsed.events) {
        throw new Error(`Webhook subscription "${spec.description}" has invalid events: ${eventsParsed.error ?? 'unknown'}`)
      }

      const headersParsed = parseCustomHeaders(spec.customHeadersJson)
      if (headersParsed.error) {
        throw new Error(`Webhook subscription "${spec.description}" has invalid custom_headers: ${headersParsed.error}`)
      }

      let filterTargetId: string | null = null
      if (spec.filterType === 'service_reference') {
        filterTargetId = findFilterTargetId(services, spec.filterTarget)
        if (!filterTargetId) {
          throw new Error(`Webhook subscription "${spec.description}" references service "${spec.filterTarget}" which was not found in the account`)
        }
      } else if (spec.filterType === 'team_reference') {
        filterTargetId = findFilterTargetId(teams, spec.filterTarget)
        if (!filterTargetId) {
          throw new Error(`Webhook subscription "${spec.description}" references team "${spec.filterTarget}" which was not found in the account`)
        }
      }

      const body = {
        webhook_subscription: buildWebhookSubscriptionBody(spec, eventsParsed.events, filterTargetId, headersParsed.headers),
      }
      const live = byDescription.get(spec.description.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ description: spec.description, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/webhook_subscriptions/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update webhook subscription "${spec.description}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/webhook_subscriptions', { body })
        if (!res.ok) throw new Error(`Failed to create webhook subscription "${spec.description}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ webhook_subscription?: LiveWebhookSubscription }>(res.body)?.webhook_subscription
        if (!created?.id) throw new Error(`Webhook subscription "${spec.description}" was created but the API returned no id`)
        rollbackState.push({ description: spec.description, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.description)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} webhook subscription(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Webhook subscription deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all webhook subscriptions in the account; throws on a non-OK response. */
export async function listWebhookSubscriptions(client: PagerDutyClient): Promise<LiveWebhookSubscription[]> {
  const res = await client.getAll<LiveWebhookSubscription>('/webhook_subscriptions', 'webhook_subscriptions')
  if (!res.ok) {
    throw new Error(
      `Failed to list webhook subscriptions: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all services (service_reference filter target NAME → id resolution). */
export async function listServices(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/services', 'services')
  if (!res.ok) {
    throw new Error(`Failed to list services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all teams (team_reference filter target NAME → id resolution). */
export async function listTeams(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/teams', 'teams')
  if (!res.ok) {
    throw new Error(`Failed to list teams: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
