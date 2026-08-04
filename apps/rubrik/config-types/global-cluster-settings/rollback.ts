import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildNtpServersBody } from './_shared'
import type { ClusterSettingsRollbackData } from './deploy'

/**
 * Undo a Global Cluster Settings deploy from rollbackData (written by deploy()),
 * restoring each area independently to its captured prior value:
 *   PATCH /api/v1/cluster/me                          (name, timezone, geolocation)
 *   POST  /api/internal/cluster/me/dns_nameserver
 *   POST  /api/internal/cluster/me/dns_search_domain
 *   POST  /api/internal/cluster/me/ntp_server
 *   PUT   /api/internal/cluster/me/login_banner
 * An area whose prior value was never captured (the deploy failed before
 * reaching it) is left untouched — this deploy never wrote it either.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as Partial<ClusterSettingsRollbackData>

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const restored: string[] = []
  try {
    if (data.timezone !== null && data.timezone !== undefined) {
      await sendJson(conn, 'PATCH', '/api/v1/cluster/me', {
        ...(data.clusterName ? { name: data.clusterName } : {}),
        timezone: { timezone: data.timezone },
        geolocation: { address: data.location ?? '' },
      })
      restored.push('identity')
    }
    if (data.dnsServers) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/dns_nameserver', data.dnsServers)
      restored.push('dns_nameservers')
    }
    if (data.dnsSearchDomains) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/dns_search_domain', data.dnsSearchDomains)
      restored.push('dns_search_domains')
    }
    if (data.ntpServers) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/ntp_server', buildNtpServersBody(data.ntpServers))
      restored.push('ntp_servers')
    }
    if (data.loginBanner !== null && data.loginBanner !== undefined) {
      await sendJson(conn, 'PUT', '/api/internal/cluster/me/login_banner', { loginBanner: data.loginBanner })
      restored.push('login_banner')
    }

    if (restored.length === 0) {
      return { success: true, message: 'Nothing to roll back.' }
    }
    return { success: true, message: `Rolled back global cluster settings: ${restored.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after [${restored.join(', ') || 'none'}]: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
