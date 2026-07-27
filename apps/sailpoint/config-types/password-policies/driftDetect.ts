import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import {
  extractPasswordPolicySpecs,
  BOOLEAN_FIELDS,
  NUMERIC_FIELDS,
  type LivePasswordPolicy,
} from './validate'

const BASE = '/v3/password-policies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractPasswordPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LivePasswordPolicy>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (live.description ?? '') as string, severity: 'warning' })
    }
    for (const key of NUMERIC_FIELDS) {
      const liveVal = typeof live[key] === 'number' ? (live[key] as number) : 0
      if (liveVal !== spec.numbers[key]) {
        diffs.push({ field: `${spec.name}.${key}`, expected: String(spec.numbers[key]), actual: String(liveVal), severity: 'warning' })
      }
    }
    for (const key of BOOLEAN_FIELDS) {
      const liveVal = live[key] === true
      if (liveVal !== spec.booleans[key]) {
        diffs.push({ field: `${spec.name}.${key}`, expected: String(spec.booleans[key]), actual: String(liveVal), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
