import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, parseJson, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractTenantConfigSpecs, parseJsonObject } from './validate'
import { REGISTRY } from './deploy'

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

  const specs = extractTenantConfigSpecs(ctx.deployedConfig).filter((s) => s.setting && REGISTRY[s.setting])

  const diffs: Diffs = []
  for (const spec of specs) {
    const reg = REGISTRY[spec.setting]
    const desired = parseJsonObject(spec.configRaw)
    if (!desired.ok) continue
    const cur = await client.get(reg.path)
    if (!cur.ok) {
      diffs.push({ field: spec.setting, expected: 'reachable', actual: 'unreadable', severity: 'warning' })
      continue
    }
    const current = parseJson<Record<string, unknown>>(cur.body) ?? {}
    for (const [k, v] of Object.entries(desired.value)) {
      if (stableStringify(current[k]) !== stableStringify(v)) {
        diffs.push({ field: `${spec.setting}.${k}`, expected: v, actual: current[k], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
