import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, extractNpaObject, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractLocalBrokerConfigSpec, type LiveLocalBrokerConfig } from './validate'

const BASE = '/infrastructure/lbrokers/brokerconfig'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const spec = extractLocalBrokerConfigSpec(ctx.deployedConfig)
  const resp = await client.get(BASE)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = extractNpaObject<LiveLocalBrokerConfig>(resp.body)?.hostname ?? ''

  const diffs: DriftResult['diffs'] = []
  if (live !== spec.hostname) {
    diffs.push({ field: 'hostname', expected: spec.hostname, actual: live, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
