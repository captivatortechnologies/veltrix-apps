import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { indexByLowerName, listProtocolTypes } from '../../lib/lookups'
import { extractLogSourceTypeSpecs } from './validate'
import { listTypes } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractLogSourceTypeSpecs(ctx.deployedConfig).filter((s) => s.name)
  const [protocols, live] = await Promise.all([listProtocolTypes(client), listTypes(client)])
  const protocolByName = indexByLowerName(protocols)
  const byName = new Map(live.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const type = byName.get(spec.name.toLowerCase())
    if (!type) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.defaultProtocolName) {
      const expectedId = protocolByName.get(spec.defaultProtocolName.toLowerCase())
      if (expectedId !== undefined && (type.default_protocol_id ?? undefined) !== expectedId) {
        diffs.push({ field: `${spec.name}.defaultProtocol`, expected: spec.defaultProtocolName, actual: String(type.default_protocol_id ?? ''), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
