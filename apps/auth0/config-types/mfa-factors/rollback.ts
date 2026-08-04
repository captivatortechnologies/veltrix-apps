import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import { GUARDIAN_FACTORS_PATH, GUARDIAN_POLICIES_PATH } from './_shared'

/**
 * Undo an MFA deploy from rollbackData (written by deploy()): PUT the prior
 * policy array back to /guardian/policies, and PUT the prior enabled state
 * back for every captured factor.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { priorPolicy?: string[]; priorFactors?: Record<string, boolean> }
  const priorPolicy = data.priorPolicy
  const priorFactors = data.priorFactors ?? {}

  if (priorPolicy === undefined && Object.keys(priorFactors).length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    if (priorPolicy !== undefined) {
      await sendJson('PUT', `${base}/${GUARDIAN_POLICIES_PATH}`, accessToken, priorPolicy)
    }
    for (const [factorName, enabled] of Object.entries(priorFactors)) {
      await sendJson('PUT', `${base}/${GUARDIAN_FACTORS_PATH}/${encodeURIComponent(factorName)}`, accessToken, { enabled })
    }

    return { success: true, message: 'Rolled back the MFA policy and factor state.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
