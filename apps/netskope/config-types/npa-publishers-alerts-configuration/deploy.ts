import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractPublisherAlertsSpec, type LivePublisherAlertsConfig } from './validate'

const BASE = '/infrastructure/publishers/alertsconfiguration'

export interface RollbackData {
  /** Whether the config had ever been set before this deploy. */
  existed: boolean
  prior?: { adminUsers: string[]; eventTypes: string[]; selectedUsers: string }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const spec = extractPublisherAlertsSpec(ctx.canvas)

  const current = await client.get(BASE)
  // A tenant that has never configured this endpoint returns 404 — treat as
  // "not yet configured" rather than a failure.
  const priorLive = current.ok ? extractNpaObject<LivePublisherAlertsConfig>(current.body) : null
  const rollbackData: RollbackData = priorLive
    ? { existed: true, prior: { adminUsers: priorLive.adminUsers ?? [], eventTypes: priorLive.eventTypes ?? [], selectedUsers: priorLive.selectedUsers ?? '' } }
    : { existed: false }

  const resp = await client.put(BASE, {
    adminUsers: spec.adminUsers,
    eventTypes: spec.eventTypes,
    selectedUsers: spec.selectedUsers,
  })
  if (!resp.ok) {
    return { success: false, message: `Failed to apply publisher alerts configuration: ${netskopeErrorMessage(resp)}`, rollbackData }
  }

  return {
    success: true,
    message: `Applied NPA publisher alerts configuration (${spec.eventTypes.length} event type(s), ${spec.adminUsers.length} admin user(s))`,
    rollbackData,
  }
}
