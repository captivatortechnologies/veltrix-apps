import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractEventForwarderSpecs, type EventForwarderSpec, type EventForwarderType } from './validate'

export interface LiveEventForwarder {
  noti_forwarder_type?: string
  comment?: string
  is_enabled?: boolean
  runner_type?: string
  event_types?: string[]
  to_emails?: string
  override_url?: string
  include_error?: boolean
  auth_type?: string
  username?: string
  client_id?: string
  user_email?: string
}
export interface LiveEventForwarderGet {
  event_forwarder?: LiveEventForwarder
}

export interface EventForwarderRollbackEntry {
  name: string
  existed: boolean
  priorSpec?: EventForwarderSpec
}

/**
 * Deploy Akeyless event forwarders. ONE item = ONE forwarder, matched on
 * NAME:
 *   - GET  /event-forwarder-get          (404 -> does not exist yet)
 *   - POST /event-forwarder-create-{type}  (type fixed for a new item)
 *   - POST /event-forwarder-update-{type}  (type must match the LIVE type)
 * Never deletes a forwarder absent from this canvas - rollback only reverts
 * what THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractEventForwarderSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: EventForwarderRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getEventForwarder(client, spec.name)

      if (existing) {
        const liveType = existing.noti_forwarder_type as EventForwarderType | undefined
        if (liveType && liveType !== spec.type) {
          throw new Error(
            `Event forwarder "${spec.name}" already exists as type "${liveType}" - this app does not support ` +
              `changing a forwarder's type in place (declared type is "${spec.type}").`,
          )
        }
        rollbackState.push({ name: spec.name, existed: true, priorSpec: mapLiveToSpec(spec, existing) })

        const res = await client.request(`/event-forwarder-update-${spec.type}`, buildBody(spec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to update event forwarder "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })

        const res = await client.request(`/event-forwarder-create-${spec.type}`, buildBody(spec, { isUpdate: false }))
        if (!res.ok) throw new Error(`Failed to create event forwarder "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} event forwarder(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedForwarders: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Event forwarder deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedForwarders: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function getEventForwarder(client: AkeylessClient, name: string): Promise<LiveEventForwarder | null> {
  const res = await client.request('/event-forwarder-get', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up event forwarder "${name}": ${akeylessErrorMessage(res)}`)
  const parsed = parseJson<LiveEventForwarderGet>(res.body)
  return parsed?.event_forwarder ?? {}
}

export function buildBody(spec: EventForwarderSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    enable: boolFlag(spec.enable),
    'runner-type': spec.runnerType,
    every: spec.every,
    'items-event-source-locations': spec.itemsEventSourceLocations,
    'targets-event-source-locations': spec.targetsEventSourceLocations,
    'auth-methods-event-source-locations': spec.authMethodsEventSourceLocations,
    'event-types': spec.eventTypes,
  }
  if (opts.isUpdate) common['new-name'] = spec.name
  // Teams uses a different (singular, required) field name than every other type.
  if (spec.type === 'teams') common['gateway-event-source-locations'] = spec.gatewaysEventSourceLocations
  else common['gateways-event-source-locations'] = spec.gatewaysEventSourceLocations

  let specific: Record<string, unknown> = {}
  switch (spec.type) {
    case 'slack':
      if (spec.webhookUrl) specific.url = spec.webhookUrl
      break
    case 'teams':
      // Akeyless requires the Webhook URL on every call for Teams - there is
      // no "leave blank to keep unchanged" semantic for this type.
      specific.url = spec.webhookUrlTeams
      break
    case 'email':
      specific = {
        'email-to': spec.emailTo,
        'override-url': spec.overrideUrl,
        'include-error': boolFlag(spec.includeError),
      }
      break
    case 'webhook':
      specific = { url: spec.url, 'auth-type': spec.authType, username: spec.username }
      if (spec.password) specific.password = spec.password
      if (spec.authToken) specific['auth-token'] = spec.authToken
      if (spec.serverCertificates) specific['server-certificates'] = spec.serverCertificates
      if (spec.clientCertData) specific['client-cert-data'] = spec.clientCertData
      if (spec.privateKeyData) specific['private-key-data'] = spec.privateKeyData
      break
    case 'servicenow':
      specific = { host: spec.host, 'auth-type': spec.serviceNowAuthType, 'admin-name': spec.adminName, 'user-email': spec.userEmail, 'client-id': spec.clientId }
      if (spec.adminPwd) specific['admin-pwd'] = spec.adminPwd
      if (spec.clientSecret) specific['client-secret'] = spec.clientSecret
      if (spec.appPrivateKeyBase64) specific['app-private-key-base64'] = spec.appPrivateKeyBase64
      break
    default:
      specific = {}
  }

  return compactBody({ ...common, ...specific })
}

/**
 * Reconstruct an EventForwarderSpec-shaped rollback snapshot from a live
 * /event-forwarder-get response, for the NON-SENSITIVE fields Akeyless
 * returns. Write-only fields (webhook URLs, passwords, tokens, certs, keys)
 * are NOT recoverable.
 */
export function mapLiveToSpec(declared: EventForwarderSpec, live: LiveEventForwarder): EventForwarderSpec {
  return {
    ...declared,
    description: live.comment ?? '',
    enable: live.is_enabled !== false,
    runnerType: live.runner_type ?? declared.runnerType,
    eventTypes: Array.isArray(live.event_types) ? live.event_types : [],
    emailTo: live.to_emails ?? '',
    overrideUrl: live.override_url ?? '',
    includeError: Boolean(live.include_error),
    authType: live.auth_type ?? declared.authType,
    username: live.username ?? '',
    clientId: live.client_id ?? '',
    userEmail: live.user_email ?? '',
  }
}
