import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractAiProviderSpecs, type LiveAiProvider } from './validate'

const BASE = '/aig/aiproviders'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractAiProviderSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAiProvider>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

  // certificate is write-only and is not diffed.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.host ?? '') !== spec.host) {
      diffs.push({ field: `${spec.name}.host`, expected: spec.host, actual: live.host ?? '', severity: 'warning' })
    }
    if ((live.port ?? 0) !== spec.port) {
      diffs.push({ field: `${spec.name}.port`, expected: String(spec.port), actual: String(live.port ?? 0), severity: 'warning' })
    }
    if ((live.protocol ?? '') !== spec.protocol) {
      diffs.push({ field: `${spec.name}.protocol`, expected: spec.protocol, actual: live.protocol ?? '', severity: 'warning' })
    }
    if ((live.schema ?? '') !== spec.schema) {
      diffs.push({ field: `${spec.name}.schema`, expected: spec.schema, actual: live.schema ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
