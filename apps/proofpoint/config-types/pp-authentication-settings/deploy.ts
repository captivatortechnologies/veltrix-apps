import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { buildLoginBody, buildMfaBody, extractAuthSettingsSpec, getLoginSettings, getMfaSettings, type LoginSettings, type MfaSettings } from './validate'

export interface AuthSettingsRollbackData {
  priorMfa: MfaSettings
  priorLogin: LoginSettings
}

/**
 * Deploy the Proofpoint Essentials Authentication Settings singleton:
 *   PUT /orgs/{org}/authentication/settings/mfa    { is_mfa_enabled, mfa_admins_only }
 *   PUT /orgs/{org}/authentication/settings/login  { allow_local_login, idp_for_forced_login,
 *                                                     allow_azure_login, force_azure_login }
 *
 * Every field has an explicit default, so this always declares the full managed
 * state (both PUTs are sent on every deploy — same "always send the full managed
 * state" approach as `pp-org-features`/Auth0's MFA factors). The prior value of
 * both resources is captured so rollback can restore them exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    return { success: true, message: 'No Authentication Settings configured.', rollbackData: {} }
  }
  const spec = extractAuthSettingsSpec(ctx.canvas)

  try {
    const priorMfa = await getMfaSettings(client)
    const priorLogin = await getLoginSettings(client)

    const mfaBody = buildMfaBody(spec)
    const mfaRes = await client.request('PUT', `${client.orgPath}/authentication/settings/mfa`, { body: mfaBody })
    if (!mfaRes.ok) throw new Error(`Failed to update MFA settings: ${ppErrorMessage(mfaRes)}`)

    const loginBody = buildLoginBody(spec)
    const loginRes = await client.request('PUT', `${client.orgPath}/authentication/settings/login`, { body: loginBody })
    if (!loginRes.ok) throw new Error(`Failed to update Login settings: ${ppErrorMessage(loginRes)}`)

    return {
      success: true,
      message:
        `Deployed authentication settings to Proofpoint Essentials org "${orgDomain}": ` +
        `MFA ${mfaBody.is_mfa_enabled ? 'required' : 'not required'}` +
        `${mfaBody.is_mfa_enabled ? ` (${mfaBody.mfa_admins_only ? 'admins only' : 'all users'})` : ''}, ` +
        `local login ${loginBody.allow_local_login ? 'allowed' : 'disabled'}, ` +
        `Azure login ${loginBody.allow_azure_login ? 'allowed' : 'disabled'}` +
        `${loginBody.force_azure_login ? ' (forced)' : ''}` +
        `${loginBody.idp_for_forced_login ? `, forced SSO IDP ${loginBody.idp_for_forced_login}` : ''}.`,
      artifacts: { baseUrl, orgDomain, mfa: mfaBody, login: loginBody },
      rollbackData: { priorMfa, priorLogin } satisfies AuthSettingsRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Authentication settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, orgDomain },
    }
  }
}
