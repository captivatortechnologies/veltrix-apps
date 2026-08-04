import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { readPolicy } from './deploy'
import { extractPasswordManagerPolicySpecs } from './_shared'

/**
 * Detect drift between the deployed Password Manager policy and the live org.
 * Best-effort: if the org can't be read (including "Password Manager disabled")
 * the check reports no drift rather than raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPasswordManagerPolicySpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs }
  const spec = specs[0]

  let live
  try {
    live = await readPolicy(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }
  if (!live) {
    diffs.push({ field: 'disableExport', expected: 'Password Manager enabled', actual: 'not enabled', severity: 'critical' })
    return { hasDrift: true, diffs }
  }

  const liveValue = Boolean(live.disableExport)
  if (liveValue !== spec.disableExport) {
    diffs.push({ field: 'disableExport', expected: String(spec.disableExport), actual: String(liveValue), severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
