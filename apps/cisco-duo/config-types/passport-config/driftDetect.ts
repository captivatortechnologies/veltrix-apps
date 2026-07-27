import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractPassportSpecs } from './validate'
import { buildPassportBody, normalizeLive, readPassportConfig } from './deploy'

type Diffs = DriftResult['diffs']

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractPassportSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const desired = buildPassportBody(specs[0])

  let live
  try {
    live = normalizeLive(await readPassportConfig(client))
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  const diffs: Diffs = []
  if (live.enabled_status !== desired.enabled_status) {
    diffs.push({ field: 'enabled_status', expected: desired.enabled_status, actual: live.enabled_status, severity: 'critical' })
  }
  if (!sameSet(live.enabled_groups, desired.enabled_groups)) {
    diffs.push({ field: 'enabled_groups', expected: desired.enabled_groups.join(', '), actual: live.enabled_groups.join(', '), severity: 'warning' })
  }
  if (!sameSet(live.disabled_groups, desired.disabled_groups)) {
    diffs.push({ field: 'disabled_groups', expected: desired.disabled_groups.join(', '), actual: live.disabled_groups.join(', '), severity: 'warning' })
  }
  if (!sameSet(live.custom_supported_browsers.macos, desired.custom_supported_browsers.macos)) {
    diffs.push({ field: 'custom_browsers_macos', expected: desired.custom_supported_browsers.macos.join(', '), actual: live.custom_supported_browsers.macos.join(', '), severity: 'warning' })
  }
  if (!sameSet(live.custom_supported_browsers.windows, desired.custom_supported_browsers.windows)) {
    diffs.push({ field: 'custom_browsers_windows', expected: desired.custom_supported_browsers.windows.join(', '), actual: live.custom_supported_browsers.windows.join(', '), severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
