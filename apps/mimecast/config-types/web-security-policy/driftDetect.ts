import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractWebSecurityPolicySpecs, type LiveWebPolicy } from './validate'
import { definitionEquals } from './deploy'

const GET_ALL = '/api/policy/webwhiteurl/get-policies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractWebSecurityPolicySpecs(ctx.deployedConfig).filter((s) => s.description && s.urls.length > 0)
  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByDesc = new Map<string, LiveWebPolicy>()
  for (const p of listed.data as LiveWebPolicy[]) {
    if (p.description) liveByDesc.set(p.description.toLowerCase(), p)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByDesc.get(spec.description.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      diffs.push({ field: `${spec.description}.definition`, expected: 'declared urls/scope', actual: 'differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
