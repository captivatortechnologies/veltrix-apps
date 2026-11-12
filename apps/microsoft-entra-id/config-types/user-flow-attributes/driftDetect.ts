import { reconciliationIssue } from '../../lib/reconciliation'
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractUserFlowAttributeSpecs, type LiveUserFlowAttribute } from './validate'

const BASE = '/identity/userFlowAttributes'
const SELECT = '?$select=id,displayName,dataType,userFlowAttributeType,description'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings, ctx.identity)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildGraphClient(cred, settings)

  const specs = extractUserFlowAttributeSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveUserFlowAttribute>(`${BASE}${SELECT}`)
  if (reconciliationIssue(listed, specs.map(s => 'name' in s ? String(s.name) : ''))) return { hasDrift: false, diffs: [], checked: false }
  if (!listed.ok || listed.truncated) return { hasDrift: false, diffs: [], checked: false }
  const liveByName = new Map(
    listed.items
      .filter((a) => a.userFlowAttributeType === 'custom' && a.displayName)
      .map((a) => [a.displayName!.toLowerCase(), a]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description || '',
        actual: live.description ?? '',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
