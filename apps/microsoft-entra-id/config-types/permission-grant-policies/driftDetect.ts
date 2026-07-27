import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  canonicalSetList,
  extractPermissionGrantPolicySpecs,
  parseArray,
  RESERVED_ID_PREFIX,
  type LivePermissionGrantPolicy,
} from './validate'

const BASE = '/policies/permissionGrantPolicies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractPermissionGrantPolicySpecs(ctx.deployedConfig).filter(
    (s) => s.id && !s.id.startsWith(RESERVED_ID_PREFIX),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const resp = await client.get(`${BASE}/${spec.id}?$select=id,displayName,description`)
    if (resp.status === 404) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!resp.ok) continue
    const live = JSON.parse(resp.body) as LivePermissionGrantPolicy

    if ((spec.displayName || '') !== (live.displayName ?? '')) {
      diffs.push({
        field: `${spec.id}.displayName`,
        expected: spec.displayName || '',
        actual: live.displayName ?? '',
        severity: 'warning',
      })
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({
        field: `${spec.id}.description`,
        expected: spec.description || '',
        actual: live.description ?? '',
        severity: 'warning',
      })
    }

    for (const kind of ['includes', 'excludes'] as const) {
      const desired = parseArray(spec[kind]) ?? []
      const current = await client.getAll<Record<string, unknown>>(`${BASE}/${spec.id}/${kind}`)
      if (!current.ok) continue
      const want = canonicalSetList(desired)
      const actual = canonicalSetList(current.items)
      if (want !== actual) {
        diffs.push({ field: `${spec.id}.${kind}`, expected: want, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
