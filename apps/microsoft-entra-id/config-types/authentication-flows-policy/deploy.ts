import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractAuthFlowsSpecs, type LiveAuthFlowsPolicy } from './validate'

const PATH = '/policies/authenticationFlowsPolicy'

export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, unknown>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractAuthFlowsSpecs(ctx.canvas)[0]
  if (!spec) return { success: true, message: 'No authentication flows policy configured', rollbackData: { entries: [] } }

  const getResp = await client.get(`${PATH}?$select=id,selfServiceSignUp`)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read authentication flows policy: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveAuthFlowsPolicy>(getResp.body) ?? {}
  const priorEnabled = live.selfServiceSignUp?.isEnabled ?? false

  const resp = await client.patch(PATH, { selfServiceSignUp: { isEnabled: spec.selfServiceSignUpEnabled } })
  if (!resp.ok) {
    return { success: false, message: `Failed to update authentication flows policy: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [{ existed: true, prior: { selfServiceSignUp: { isEnabled: priorEnabled } } }]
  return {
    success: true,
    message: `Self-service sign-up ${spec.selfServiceSignUpEnabled ? 'enabled' : 'disabled'}`,
    rollbackData: { entries },
  }
}
