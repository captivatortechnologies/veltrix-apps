import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractBasicSecuritySpec, getBasicSecurity } from './validate'

/** Detect drift between the deployed Basic Security value and the live Application. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const sections = ctx.deployedConfig.sections ?? []
  if (sections.length === 0) return { hasDrift: false, diffs: [] }
  const spec = extractBasicSecuritySpec(ctx.deployedConfig)

  try {
    const live = await getBasicSecurity(client, appName)
    if ((live.protection_mode ?? '') !== spec.protectionMode) {
      diffs.push({ field: 'protection_mode', expected: spec.protectionMode, actual: live.protection_mode ?? 'not set', severity: 'critical' })
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
