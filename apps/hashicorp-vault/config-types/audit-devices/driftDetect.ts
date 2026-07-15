import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { findLiveDevice, listAuditDevices } from './deploy'
import { buildAuditOptions, extractAuditDeviceSpecs, type LiveAuditDevice } from './validate'

/**
 * Detect drift between the deployed audit device configuration and live Vault
 * state. Reads GET /sys/audit ONCE (there is no tune endpoint to read) and, per
 * declared device, diffs the type (critical — a type change means a different
 * backend) and the managed options (warning). Only the options THIS config
 * manages are compared; Vault's own defaults are ignored.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuditDeviceSpecs(ctx.deployedConfig).filter((s) => s.path && s.type)

  let liveMap: Record<string, LiveAuditDevice>
  try {
    liveMap = await listAuditDevices(client)
  } catch (error) {
    // Vault unreachable — surface it once per declared device.
    for (const spec of specs) {
      diffs.push({
        field: spec.path,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
    return { hasDrift: diffs.length > 0, diffs }
  }

  for (const spec of specs) {
    const live = findLiveDevice(liveMap, spec.path)

    if (!live) {
      diffs.push({ field: spec.path, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    // A type change means the backend is entirely different — critical.
    if ((live.type ?? '') !== spec.type) {
      diffs.push({
        field: `${spec.path}.type`,
        expected: spec.type,
        actual: live.type ?? 'not set',
        severity: 'critical',
      })
    }

    // Managed options only (no tune to read) — a mismatch is a warning.
    const desired = buildAuditOptions(spec)
    const liveOptions = live.options ?? {}
    for (const [key, value] of Object.entries(desired)) {
      const actual = String(liveOptions[key] ?? '')
      if (actual !== String(value)) {
        diffs.push({
          field: `${spec.path}.options.${key}`,
          expected: value,
          actual: actual || 'not set',
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
