import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractTransformSpecs, parseAttributes, type LiveTransform } from './validate'

const BASE = '/transforms/v1'

type Diffs = DriftResult['diffs']

/** Stable stringify so attribute key order doesn't read as drift. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractTransformSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTransform>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t])
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.type && live.type && live.type !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.type, severity: 'critical' })
    }
    const parsed = parseAttributes(spec.attributesRaw)
    const wantAttrs = parsed.ok ? parsed.value : {}
    const liveAttrs = live.attributes ?? {}
    if (stableStringify(liveAttrs) !== stableStringify(wantAttrs)) {
      diffs.push({
        field: `${spec.name}.attributes`,
        expected: wantAttrs,
        actual: liveAttrs,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
