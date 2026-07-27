import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAuthContextSpecs, type LiveAuthContext } from './validate'

const BASE = '/identity/conditionalAccess/authenticationContextClassReferences'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAuthContextSpecs(ctx.deployedConfig).filter((s) => s.contextId)
  const listed = await client.getAll<LiveAuthContext>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveById = new Map(listed.items.filter((c) => c.id).map((c) => [c.id!, c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveById.get(spec.contextId)
    if (!live) {
      diffs.push({ field: spec.contextId, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantName = spec.displayName || ''
    const liveName = (live.displayName ?? '') as string
    if (liveName !== wantName) {
      diffs.push({
        field: `${spec.contextId}.displayName`,
        expected: wantName,
        actual: liveName,
        severity: 'warning',
      })
    }
    const wantDescription = spec.description || ''
    const liveDescription = (live.description ?? '') as string
    if (liveDescription !== wantDescription) {
      diffs.push({
        field: `${spec.contextId}.description`,
        expected: wantDescription,
        actual: liveDescription,
        severity: 'warning',
      })
    }
    const liveAvailable = live.isAvailable === true
    if (spec.isAvailable !== liveAvailable) {
      diffs.push({
        field: `${spec.contextId}.isAvailable`,
        expected: String(spec.isAvailable),
        actual: String(liveAvailable),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
