import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type NetworkDevice, type NetworkDeviceIp } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/** Render an IP list as a sorted, comparable string for a simple diff. */
function ipListKey(entries: NetworkDeviceIp[] | undefined): string {
  return (entries ?? [])
    .map((e) => `${e.ipaddress}/${e.mask}`)
    .sort()
    .join(', ')
}

function groupListKey(groups: string[] | undefined): string {
  return [...(groups ?? [])].sort().join(', ')
}

/**
 * Drift for network devices: a declared device missing from ISE is critical
 * drift; a description, IP list, or NDG membership mismatch is a warning.
 * ⚠ The RADIUS shared secret is NEVER compared — ISE never returns it, so
 * there is nothing to diff against (see deploy.ts's write-only secret note).
 * Read-only. Best-effort — a device that can't be read is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<NetworkDevice>(base, 'networkdevice', 'NetworkDevice', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.name) continue

    let existing
    try {
      existing = await client.findByName(spec.name)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedDescription = spec.description
    const actualDescription = String(live.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const expectedIps = ipListKey(spec.ipEntries)
    const actualIps = ipListKey(live.NetworkDeviceIPList)
    if (expectedIps !== actualIps) {
      diffs.push({ field: `${spec.name}.ip_addresses`, expected: expectedIps, actual: actualIps, severity: 'warning' })
    }

    const expectedGroups = groupListKey(spec.deviceGroups)
    const actualGroups = groupListKey(live.NetworkDeviceGroupList)
    if (expectedGroups !== actualGroups) {
      diffs.push({ field: `${spec.name}.device_groups`, expected: expectedGroups, actual: actualGroups, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
