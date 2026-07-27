import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractSecurityDefaultsSpecs, type LiveSecurityDefaults } from './validate'

const PATH = '/policies/identitySecurityDefaultsEnforcementPolicy'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractSecurityDefaultsSpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const resp = await client.get(`${PATH}?$select=id,isEnabled`)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveSecurityDefaults>(resp.body) ?? {}

  const diffs: DriftResult['diffs'] = []
  if (spec.isEnabled !== (live.isEnabled === true)) {
    diffs.push({
      field: 'isEnabled',
      expected: String(spec.isEnabled),
      actual: String(live.isEnabled === true),
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
