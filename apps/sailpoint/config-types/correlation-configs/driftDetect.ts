import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractCorrelationConfigSpecs, parseJsonArray, type LiveCorrelationConfig } from './validate'

const BASE = '/v3/correlation-config'

type Diffs = DriftResult['diffs']

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractCorrelationConfigSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveCorrelationConfig>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((c) => c.name).map((c) => [c.name!.toLowerCase(), c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const parsed = parseJsonArray(spec.attributesRaw)
    const want = parsed.ok ? parsed.value : []
    if (stableStringify(live.attributes ?? []) !== stableStringify(want)) {
      diffs.push({ field: `${spec.name}.attributes`, expected: want, actual: live.attributes ?? [], severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
