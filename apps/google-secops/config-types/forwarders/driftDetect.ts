import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractForwarderSpecs } from './validate'
import { listForwarders } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listForwarders(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.forwarders.map((fw) => [fw.displayName ?? '', fw]))

  const specs = extractForwarderSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // Compare only the stable scalars the user explicitly declared — the server
    // fills nested config defaults, so a deep compare would report false drift.
    const cfg = spec.config ?? {}
    if (typeof cfg.uploadCompression === 'boolean' && (live.config?.uploadCompression ?? false) !== cfg.uploadCompression) {
      diffs.push({ field: `${spec.displayName}.uploadCompression`, expected: String(cfg.uploadCompression), actual: String(live.config?.uploadCompression ?? false), severity: 'warning' })
    }
    const meta = (cfg.metadata ?? {}) as { assetNamespace?: string }
    if (typeof meta.assetNamespace === 'string' && (live.config?.metadata?.assetNamespace ?? '') !== meta.assetNamespace) {
      diffs.push({ field: `${spec.displayName}.metadata.assetNamespace`, expected: meta.assetNamespace, actual: live.config?.metadata?.assetNamespace ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
