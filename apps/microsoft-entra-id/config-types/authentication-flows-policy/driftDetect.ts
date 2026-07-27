import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAuthFlowsSpecs, type LiveAuthFlowsPolicy } from './validate'

const PATH = '/policies/authenticationFlowsPolicy'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractAuthFlowsSpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const resp = await client.get(`${PATH}?$select=id,selfServiceSignUp`)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAuthFlowsPolicy>(resp.body) ?? {}
  const liveEnabled = live.selfServiceSignUp?.isEnabled === true

  const diffs: DriftResult['diffs'] = []
  if (spec.selfServiceSignUpEnabled !== liveEnabled) {
    diffs.push({
      field: 'selfServiceSignUp.isEnabled',
      expected: String(spec.selfServiceSignUpEnabled),
      actual: String(liveEnabled),
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
