import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import type { AuthSettingsRollbackData } from './deploy'

/**
 * Roll back the Authentication Settings singleton by PUTting back the exact MFA
 * and Login settings captured before this deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as AuthSettingsRollbackData | undefined
  if (!data?.priorMfa || !data?.priorLogin) {
    return { success: true, message: 'Nothing to roll back — no prior authentication settings were captured.' }
  }

  try {
    const mfaRes = await client.request('PUT', `${client.orgPath}/authentication/settings/mfa`, { body: data.priorMfa })
    if (!mfaRes.ok) throw new Error(`Failed to restore MFA settings: ${ppErrorMessage(mfaRes)}`)

    const loginRes = await client.request('PUT', `${client.orgPath}/authentication/settings/login`, { body: data.priorLogin })
    if (!loginRes.ok) throw new Error(`Failed to restore Login settings: ${ppErrorMessage(loginRes)}`)

    return { success: true, message: 'Rolled back the MFA and Login/SSO settings to their prior values.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
