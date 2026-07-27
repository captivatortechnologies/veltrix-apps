import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractEnterpriseSettingsSpecs, buildOverlay } from './validate'

const BASE = '/settings/enterprise'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const spec = extractEnterpriseSettingsSpecs(ctx.deployedConfig).filter((s) => !s.defaultPoliciesError)[0]
  if (!spec) return { hasDrift: false, diffs: [] }
  const overlay = buildOverlay(spec)
  if (Object.keys(overlay).length === 0) return { hasDrift: false, diffs: [] }

  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const current = parseJson<Record<string, unknown>>(res.body) ?? {}

  const diffs: Diffs = []
  for (const [key, expected] of Object.entries(overlay)) {
    const actual = current[key]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      diffs.push({ field: key, expected: JSON.stringify(expected), actual: JSON.stringify(actual ?? null), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
