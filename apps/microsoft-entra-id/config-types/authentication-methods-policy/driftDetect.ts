import { canonical, managedProjection } from '../../lib/managedResources'
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAuthMethodSpecs, METHOD_ODATA_TYPES, type LiveAuthMethodConfig } from './validate'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings, ctx.identity)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildGraphClient(cred, settings)

  const specs = extractAuthMethodSpecs(ctx.deployedConfig).filter((s) => s.method in METHOD_ODATA_TYPES)

  const diffs: DriftResult['diffs'] = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const resp = await client.get(`${BASE}/${spec.method}?$select=id,state${spec.configuration?','+Object.keys(spec.configuration).join(','):''}`)
    if (!resp.ok) {
      checkedAll = false
      continue
    }
    const live = parseJson<LiveAuthMethodConfig>(resp.body)
    if(spec.configurationError){checkedAll=false;continue}
    if(spec.configuration){
      const actual=managedProjection(live??{},spec.configuration)
      if(canonical(actual)!==canonical(spec.configuration))diffs.push({field:`${spec.method}.configuration`,expected:spec.configuration,actual,severity:'warning'})
    }
    const liveState = live?.state ?? 'disabled'
    if (liveState !== spec.state) {
      diffs.push({
        field: `${spec.method}.state`,
        expected: spec.state,
        actual: liveState,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
