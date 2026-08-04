import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs } from './_shared'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const expected = extractSpecs(ctx.deployedConfig)[0]?.mode
  if (!expected || !hasUsableCredential(ctx.credential)) return { hasDrift: false, diffs: [] }
  const built = buildPfsenseClient(ctx.component, ctx.connectivity, ctx.credential, readPfsenseSettings(ctx.settings), ctx.connectivityProvider)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const auth = await built.client.authenticate()
  if (auth.error) return { hasDrift: false, diffs: [] }
  try {
    const actual = await built.client.getOutboundNatMode()
    const diffs = actual === expected ? [] : [{ field: 'mode', expected, actual, severity: 'critical' as const }]
    return { hasDrift: diffs.length > 0, diffs }
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
}
