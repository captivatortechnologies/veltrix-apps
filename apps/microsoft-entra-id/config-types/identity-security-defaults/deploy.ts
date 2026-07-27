import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractSecurityDefaultsSpecs, type LiveSecurityDefaults } from './validate'

const PATH = '/policies/identitySecurityDefaultsEnforcementPolicy'

export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, unknown>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractSecurityDefaultsSpecs(ctx.canvas)[0]
  if (!spec) return { success: true, message: 'No security defaults policy configured', rollbackData: { entries: [] } }

  const getResp = await client.get(`${PATH}?$select=id,isEnabled`)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read security defaults: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveSecurityDefaults>(getResp.body) ?? {}

  const resp = await client.patch(PATH, { isEnabled: spec.isEnabled })
  if (!resp.ok) {
    return { success: false, message: `Failed to update security defaults: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [{ existed: true, prior: { isEnabled: live.isEnabled ?? false } }]
  return {
    success: true,
    message: `Security defaults set to ${spec.isEnabled ? 'enabled' : 'disabled'}`,
    rollbackData: { entries },
  }
}
