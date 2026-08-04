import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import { BREACHED_PASSWORD_DETECTION_PATH, BRUTE_FORCE_PROTECTION_PATH, SUSPICIOUS_IP_THROTTLING_PATH } from './_shared'

/**
 * Undo an Attack Protection deploy from rollbackData (written by deploy()):
 * PATCH each touched sub-resource back to its captured prior object. A
 * sub-resource the deploy never touched has no entry here and is left alone —
 * Attack Protection sub-resources always exist, so there is never a "delete"
 * case, only "restore" or "leave untouched".
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    breachedPasswordDetection?: Record<string, unknown>
    bruteForceProtection?: Record<string, unknown>
    suspiciousIpThrottling?: Record<string, unknown>
  }

  if (!data.breachedPasswordDetection && !data.bruteForceProtection && !data.suspiciousIpThrottling) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const restored: string[] = []
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    if (data.breachedPasswordDetection) {
      await sendJson('PATCH', `${base}/${BREACHED_PASSWORD_DETECTION_PATH}`, accessToken, data.breachedPasswordDetection)
      restored.push('breached-password-detection')
    }
    if (data.bruteForceProtection) {
      await sendJson('PATCH', `${base}/${BRUTE_FORCE_PROTECTION_PATH}`, accessToken, data.bruteForceProtection)
      restored.push('brute-force-protection')
    }
    if (data.suspiciousIpThrottling) {
      await sendJson('PATCH', `${base}/${SUSPICIOUS_IP_THROTTLING_PATH}`, accessToken, data.suspiciousIpThrottling)
      restored.push('suspicious-ip-throttling')
    }

    return { success: true, message: `Rolled back Attack Protection: ${restored.join(', ')}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
