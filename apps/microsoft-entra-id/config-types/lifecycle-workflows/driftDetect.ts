import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractWorkflowSpecs, parseArray, parseObject, type LiveWorkflow } from './validate'

const BASE = '/identityGovernance/lifecycleWorkflows/workflows'
const SELECT = '?$select=id,category,displayName,description,isEnabled,isSchedulingEnabled,executionConditions,tasks'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractWorkflowSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveWorkflow>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((w) => w.displayName).map((w) => [w.displayName!.toLowerCase(), w]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.isEnabled !== (live.isEnabled === true)) {
      diffs.push({ field: `${spec.name}.isEnabled`, expected: String(spec.isEnabled), actual: String(live.isEnabled === true), severity: 'warning' })
    }
    if (spec.isSchedulingEnabled !== (live.isSchedulingEnabled === true)) {
      diffs.push({ field: `${spec.name}.isSchedulingEnabled`, expected: String(spec.isSchedulingEnabled), actual: String(live.isSchedulingEnabled === true), severity: 'warning' })
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description || '', actual: live.description ?? '', severity: 'warning' })
    }
    const wantConditions = canonical(parseObject(spec.executionConditions) ?? {})
    const liveConditions = canonical(live.executionConditions ?? {})
    if (wantConditions !== liveConditions) {
      diffs.push({ field: `${spec.name}.executionConditions`, expected: wantConditions, actual: liveConditions, severity: 'warning' })
    }
    const wantTasks = canonical(parseArray(spec.tasks) ?? [])
    const liveTasks = canonical(live.tasks ?? [])
    if (wantTasks !== liveTasks) {
      diffs.push({ field: `${spec.name}.tasks`, expected: wantTasks, actual: liveTasks, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
