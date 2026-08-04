import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { SYSLOG_ENDPOINTS, findSyslogIntegration, syslogIntegrationsFromReply } from './_shared'

/**
 * Drift for syslog integrations: compare address, port, protocol and facility we
 * declare against the live integration in Cortex XDR (a genuine full-CRUD
 * surface, so this read is real). Best-effort — an integration that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. `security_info` is not diffed — `certificate_content` is write-only and
 * never returned by the read. Read-only: POST /integrations/syslog/get/.
 *
 * VERIFY the get response field names against a live Cortex XDR tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.call(SYSLOG_ENDPOINTS.get, {})
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = syslogIntegrationsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findSyslogIntegration(live, name)
    if (!match) continue

    const expectedAddress = String(item.fields.address ?? '').trim()
    if (expectedAddress && expectedAddress !== String(match.SYSLOG_INTEGRATION_ADDRESS ?? '')) {
      diffs.push({ field: `${name}.address`, expected: expectedAddress, actual: match.SYSLOG_INTEGRATION_ADDRESS, severity: 'warning' })
    }

    const expectedPort = Number(item.fields.port ?? 0)
    if (expectedPort && expectedPort !== Number(match.SYSLOG_INTEGRATION_PORT ?? 0)) {
      diffs.push({ field: `${name}.port`, expected: expectedPort, actual: match.SYSLOG_INTEGRATION_PORT, severity: 'warning' })
    }

    const expectedProtocol = String(item.fields.protocol ?? '').trim().toUpperCase()
    const actualProtocol = String(match.SYSLOG_INTEGRATION_PROTOCOL ?? '').trim().toUpperCase()
    if (expectedProtocol && expectedProtocol !== actualProtocol) {
      diffs.push({ field: `${name}.protocol`, expected: expectedProtocol, actual: actualProtocol, severity: 'warning' })
    }

    const expectedFacility = String(item.fields.facility ?? '').trim()
    if (expectedFacility && expectedFacility !== String(match.FACILITY ?? '')) {
      diffs.push({ field: `${name}.facility`, expected: expectedFacility, actual: match.FACILITY, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
