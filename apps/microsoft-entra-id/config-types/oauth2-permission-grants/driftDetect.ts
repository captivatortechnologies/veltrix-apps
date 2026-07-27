import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractOAuth2GrantSpecs, grantKey, normalizeScope, type LiveOAuth2Grant } from './validate'

const BASE = '/oauth2PermissionGrants'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractOAuth2GrantSpecs(ctx.deployedConfig).filter((s) => s.clientId && s.resourceId)
  const listed = await client.getAll<LiveOAuth2Grant>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(listed.items.filter((g) => g.id).map((g) => [grantKey(g), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const key = grantKey(spec)
    const live = liveByKey.get(key)
    if (!live) {
      diffs.push({ field: key, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const want = normalizeScope(spec.scope)
    const actual = normalizeScope(live.scope)
    if (want !== actual) {
      diffs.push({ field: `${key}.scope`, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
