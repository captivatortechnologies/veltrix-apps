import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractParserSpecs } from './validate'
import { activeParser, decodeCbn, listParsers, normalizeCode } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractParserSpecs(ctx.deployedConfig).filter((s) => s.logType && s.code.trim())
  const diffs: Diffs = []
  for (const spec of specs) {
    const listed = await listParsers(client, parent, spec.logType)
    if (!listed.ok) continue
    const active = activeParser(listed.parsers)
    if (!active) {
      diffs.push({ field: spec.logType, expected: 'active parser present', actual: 'no active parser', severity: 'critical' })
      continue
    }
    if (normalizeCode(decodeCbn(active.cbn)) !== normalizeCode(spec.code)) {
      diffs.push({ field: `${spec.logType}.code`, expected: 'declared parser code', actual: 'differs from active parser', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
