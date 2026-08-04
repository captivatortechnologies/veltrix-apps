import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson, sendJson } from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  FACTOR_FIELD_TO_NAME,
  GUARDIAN_FACTORS_PATH,
  GUARDIAN_POLICIES_PATH,
  indexFactors,
  policyToArray,
  readFactorFields,
  type Auth0GuardianFactor,
} from './_shared'

/**
 * Deploy Auth0 MFA (Guardian) over the Management API v2:
 *   PUT /guardian/policies          the declared policy's array form
 *   PUT /guardian/factors/{name}    { enabled } for all 8 managed factors
 *
 * This config type always fully declares the managed factor set — the 8
 * checkboxes are booleans with an explicit default, so every deploy sends all
 * 8 PUTs (same "always send the full managed state" approach as `clients`'
 * URL arrays). rollbackData captures the prior policy array and the prior
 * enabled state of every managed factor.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No MFA settings configured.', rollbackData: {} }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const priorPolicyArray = await getJson<string[]>(`${base}/${GUARDIAN_POLICIES_PATH}`, accessToken)
    const priorFactorsList = await getJson<Auth0GuardianFactor[]>(`${base}/${GUARDIAN_FACTORS_PATH}`, accessToken)
    const priorFactors = indexFactors(Array.isArray(priorFactorsList) ? priorFactorsList : [])

    const policy = readString(item.fields.policy) || 'never'
    await sendJson('PUT', `${base}/${GUARDIAN_POLICIES_PATH}`, accessToken, policyToArray(policy))

    const desiredFactors = readFactorFields(item.fields)
    for (const factorName of Object.values(FACTOR_FIELD_TO_NAME)) {
      await sendJson('PUT', `${base}/${GUARDIAN_FACTORS_PATH}/${encodeURIComponent(factorName)}`, accessToken, {
        enabled: desiredFactors[factorName],
      })
    }

    return {
      success: true,
      message: `Applied MFA policy "${policy}" and ${Object.keys(desiredFactors).length} factor(s).`,
      artifacts: { policy, factors: desiredFactors },
      rollbackData: { priorPolicy: Array.isArray(priorPolicyArray) ? priorPolicyArray : [], priorFactors },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 MFA deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
