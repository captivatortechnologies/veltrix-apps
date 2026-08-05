import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, extractNpaObject, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractPublisherAlertsSpec, type LivePublisherAlertsConfig } from './validate'

const BASE = '/infrastructure/publishers/alertsconfiguration'

function sortedSig(tokens: string[]): string {
  return [...tokens].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const spec = extractPublisherAlertsSpec(ctx.deployedConfig)
  const resp = await client.get(BASE)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = extractNpaObject<LivePublisherAlertsConfig>(resp.body)

  const diffs: DriftResult['diffs'] = []
  if (!live) {
    diffs.push({ field: 'alertsConfiguration', expected: 'configured', actual: 'not configured', severity: 'critical' })
    return { hasDrift: true, diffs }
  }

  const expectedAdmins = sortedSig(spec.adminUsers)
  const actualAdmins = sortedSig(live.adminUsers ?? [])
  if (expectedAdmins !== actualAdmins) {
    diffs.push({ field: 'adminUsers', expected: expectedAdmins, actual: actualAdmins, severity: 'warning' })
  }

  const expectedEvents = sortedSig(spec.eventTypes)
  const actualEvents = sortedSig(live.eventTypes ?? [])
  if (expectedEvents !== actualEvents) {
    diffs.push({ field: 'eventTypes', expected: expectedEvents, actual: actualEvents, severity: 'warning' })
  }

  if ((live.selectedUsers ?? '') !== spec.selectedUsers) {
    diffs.push({ field: 'selectedUsers', expected: spec.selectedUsers, actual: live.selectedUsers ?? '', severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
