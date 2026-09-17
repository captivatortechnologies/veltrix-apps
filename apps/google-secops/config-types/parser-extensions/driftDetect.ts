import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractParserExtensionSpecs } from './validate'
import { listExtensions } from './deploy'
import { decodeCbn, normalizeCode } from '../parsers/deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractParserExtensionSpecs(ctx.deployedConfig).filter((s) => s.logType && s.cbnSnippet.trim())
  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const listed = await listExtensions(client, parent, spec.logType)
    if (!listed.ok) {
      checkedAll = false
      continue
    }
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

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
