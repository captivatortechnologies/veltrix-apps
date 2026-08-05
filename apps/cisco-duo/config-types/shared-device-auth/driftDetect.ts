import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractSharedDeviceAuthSpecs, liveGroupIds, liveTrustedEndpointIntegrationIds, type LiveSharedDeviceAuth } from './validate'

const BASE = '/admin/v1/desktop_authenticators/shared_device_auth'

type Diffs = DriftResult['diffs']

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractSharedDeviceAuthSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllV5<LiveSharedDeviceAuth>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((c) => c.name).map((c) => [c.name!.toLowerCase(), c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.active === true) !== spec.active) {
      diffs.push({ field: `${spec.name}.active`, expected: String(spec.active), actual: String(live.active === true), severity: 'warning' })
    }
    const lGroups = liveGroupIds(live)
    if (!sameSet(lGroups, spec.groupIds)) {
      diffs.push({ field: `${spec.name}.group_ids`, expected: spec.groupIds.join(', '), actual: lGroups.join(', '), severity: 'warning' })
    }
    const lIntegrations = liveTrustedEndpointIntegrationIds(live)
    if (!sameSet(lIntegrations, spec.trustedEndpointIntegrationIds)) {
      diffs.push({
        field: `${spec.name}.trusted_endpoint_integration_ids`,
        expected: spec.trustedEndpointIntegrationIds.join(', '),
        actual: lIntegrations.join(', '),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
