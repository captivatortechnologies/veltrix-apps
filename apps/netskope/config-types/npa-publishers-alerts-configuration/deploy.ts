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
  // A tenant that has never configured this endpoint returns 404 — a KNOWN
  // answer, treated as "not yet configured".
  //
  // Any other failure is not. `current.ok ? … : null` applied the 404 reading to
  // a 403, a 500 and a transport error too, so a transient blip recorded
  // `existed: false` and the PUT below replaced the tenant-wide publisher
  // alerting policy with no record of what it had been. Rollback then said
  // "Nothing to restore" and made no call: nobody is paged for a publisher
  // upgrade or a connection failure again, and the only copy is gone.
  if (!current.ok && current.status !== 404) {
    return {
      success: false,
      message:
        `Could not read the current publisher alerts configuration, so it was not replaced: ${netskopeErrorMessage(current)}. ` +
        'Overwriting it without capturing what was there would leave nothing to roll back to.',
      rollbackData: { existed: false },
    }
  }
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
