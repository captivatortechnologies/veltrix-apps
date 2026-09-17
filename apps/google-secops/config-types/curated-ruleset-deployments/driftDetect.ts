import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractCuratedDeploymentSpecs, type LiveCuratedDeployment } from './validate'
import { deploymentMatches, deploymentPath } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractCuratedDeploymentSpecs(ctx.deployedConfig).filter((s) => s.category && s.ruleSet)
  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const getRes = await client.request('GET', deploymentPath(parent, spec))
    const label = `${spec.category}/${spec.ruleSet}/${spec.precision}`
    if (getRes.status === 404) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) {
      checkedAll = false
      continue
    }
    const live = parseJson<LiveCuratedDeployment>(getRes.body) ?? {}
    if (!deploymentMatches(live, spec)) {
      diffs.push({ field: `${label}.state`, expected: `enabled=${spec.enabled}, alerting=${spec.alerting}`, actual: `enabled=${live.enabled ?? false}, alerting=${live.alerting ?? false}`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
