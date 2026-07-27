import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, parseJson, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractMfaConfigSpecs, type LiveMfaConfig } from './validate'

const configPath = (method: string): string => `/v3/mfa/${method}/config`

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractMfaConfigSpecs(ctx.deployedConfig).filter((s) => s.method)

  // configProperties are secret-bearing and masked on GET, so drift tracks the
  // enabled flag and identity attribute only.
  const diffs: Diffs = []
  for (const spec of specs) {
    const cur = await client.get(configPath(spec.method))
    if (!cur.ok) {
      diffs.push({ field: spec.method, expected: 'present', actual: 'unreadable', severity: 'warning' })
      continue
    }
    const live = parseJson<LiveMfaConfig>(cur.body) ?? {}
    if ((live.enabled ?? false) !== spec.enabled) {
      diffs.push({ field: `${spec.method}.enabled`, expected: String(spec.enabled), actual: String(live.enabled ?? false), severity: 'warning' })
    }
    if (spec.identityAttribute && (live.identityAttribute ?? '') !== spec.identityAttribute) {
      diffs.push({ field: `${spec.method}.identityAttribute`, expected: spec.identityAttribute, actual: live.identityAttribute ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
