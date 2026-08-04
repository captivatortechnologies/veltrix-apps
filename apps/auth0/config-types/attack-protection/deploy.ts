import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson, sendJson } from '../../lib/auth0Api'
import {
  BREACHED_PASSWORD_DETECTION_PATH,
  BRUTE_FORCE_PROTECTION_PATH,
  SUSPICIOUS_IP_THROTTLING_PATH,
  declaredObjectField,
  type BreachedPasswordDetection,
  type BruteForceProtection,
  type SuspiciousIpThrottling,
} from './_shared'

/**
 * Deploy Auth0 Attack Protection over the Management API v2. Each of the
 * three sub-resources always exists (GET/PATCH only) — a deploy only touches
 * the ones the operator declared (a non-blank field); a blank field is left
 * alone, never cleared. For each touched sub-resource, GET the current live
 * object first (for rollback), then PATCH the declared object.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No Attack Protection settings configured.', rollbackData: {} }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const rollbackData: Record<string, unknown> = {}
  const touched: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const breached = declaredObjectField(item.fields.breached_password_detection)
    if (breached.declared) {
      const prior = await getJson<BreachedPasswordDetection>(`${base}/${BREACHED_PASSWORD_DETECTION_PATH}`, accessToken)
      await sendJson('PATCH', `${base}/${BREACHED_PASSWORD_DETECTION_PATH}`, accessToken, breached.value)
      rollbackData.breachedPasswordDetection = prior
      touched.push('breached-password-detection')
    }

    const bruteForce = declaredObjectField(item.fields.brute_force_protection)
    if (bruteForce.declared) {
      const prior = await getJson<BruteForceProtection>(`${base}/${BRUTE_FORCE_PROTECTION_PATH}`, accessToken)
      await sendJson('PATCH', `${base}/${BRUTE_FORCE_PROTECTION_PATH}`, accessToken, bruteForce.value)
      rollbackData.bruteForceProtection = prior
      touched.push('brute-force-protection')
    }

    const suspiciousIp = declaredObjectField(item.fields.suspicious_ip_throttling)
    if (suspiciousIp.declared) {
      const prior = await getJson<SuspiciousIpThrottling>(`${base}/${SUSPICIOUS_IP_THROTTLING_PATH}`, accessToken)
      await sendJson('PATCH', `${base}/${SUSPICIOUS_IP_THROTTLING_PATH}`, accessToken, suspiciousIp.value)
      rollbackData.suspiciousIpThrottling = prior
      touched.push('suspicious-ip-throttling')
    }

    return {
      success: true,
      message:
        touched.length > 0
          ? `Applied Attack Protection: ${touched.join(', ')}.`
          : 'No Attack Protection sub-resource declared; nothing to apply.',
      artifacts: { touched },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 Attack Protection deploy failed after ${touched.length} sub-resource(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { touched },
      rollbackData,
    }
  }
}
