import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractParserExtensionSpecs } from './validate'
import { listExtensions } from './deploy'
import { decodeCbn, normalizeCode } from '../parsers/deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractParserExtensionSpecs(ctx.deployedConfig).filter((s) => s.logType && s.cbnSnippet.trim())
  const diffs: Diffs = []
  for (const spec of specs) {
    const listed = await listExtensions(client, parent, spec.logType)
    if (!listed.ok) continue
    if (listed.extensions.length === 0) {
      diffs.push({ field: spec.logType, expected: 'extension present', actual: 'no extension', severity: 'critical' })
      continue
    }
    // Snippets may not round-trip; only flag drift when a decodable snippet exists
    // and none of them matches the declared one.
    const decodables = listed.extensions.map((e) => decodeCbn(e.cbnSnippet)).filter((s) => s !== '')
    if (decodables.length === 0) continue
    if (!decodables.some((d) => normalizeCode(d) === normalizeCode(spec.cbnSnippet))) {
      diffs.push({ field: `${spec.logType}.cbnSnippet`, expected: 'declared snippet', actual: 'differs from live extensions', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
