import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  envelopeError,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractLocalBrokerConfigSpec, type LiveLocalBrokerConfig } from './validate'

const BASE = '/infrastructure/lbrokers/brokerconfig'

export interface RollbackData {
  /** Hostname before this deploy — empty string means "not configured". */
  priorHostname: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const spec = extractLocalBrokerConfigSpec(ctx.canvas)

  const current = await client.get(BASE)
  if (!current.ok) return { success: false, message: `Failed to read local broker config: ${netskopeErrorMessage(current)}` }
  // `current.ok` is true for a 200 carrying { status: 'error' }, and
  // extractNpaObject then returns the error object — whose `hostname` is
  // undefined, so the prior was recorded as ''. Rolling that deploy back CLEARS
  // the tenant-wide local-broker hostname instead of restoring it.
  const envelopeFailure = envelopeError(current.body)
  if (envelopeFailure) {
    return {
      success: false,
      message:
        `Could not read the current local broker config, so it was not replaced: ${envelopeFailure}. ` +
        'Recording an empty hostname as the prior state would make a rollback clear it.',
    }
  }
  const priorHostname = extractNpaObject<LiveLocalBrokerConfig>(current.body)?.hostname ?? ''

  const resp = await client.put(BASE, { hostname: spec.hostname })
  if (!resp.ok) {
    return { success: false, message: `Failed to apply local broker config: ${netskopeErrorMessage(resp)}`, rollbackData: { priorHostname } }
  }

  const rollbackData: RollbackData = { priorHostname }
  return {
    success: true,
    message: `Applied NPA local broker config (hostname: ${spec.hostname || '(none)'})`,
    rollbackData,
  }
}
