import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAuthMethodSpecs, METHOD_ODATA_TYPES, type LiveAuthMethodConfig } from './validate'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAuthMethodSpecs(ctx.deployedConfig).filter((s) => s.method in METHOD_ODATA_TYPES)

  const diffs: DriftResult['diffs'] = []
  for (const spec of specs) {
    const resp = await client.get(`${BASE}/${spec.method}?$select=id,state`)
    if (!resp.ok) continue
    const live = parseJson<LiveAuthMethodConfig>(resp.body)
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

  return { hasDrift: diffs.length > 0, diffs }
}
