import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildClusterInfoPatch,
  buildClusterSettingsSpec,
  buildNtpServersBody,
  ntpServersFrom,
  stringListFrom,
  stringListsEqual,
  type LoginBannerResponse,
  type RubrikClusterInfo,
} from './_shared'

export interface ClusterSettingsRollbackData {
  clusterName: string | null
  timezone: string | null
  location: string | null
  dnsServers: string[] | null
  dnsSearchDomains: string[] | null
  ntpServers: string[] | null
  loginBanner: string | null
}

/**
 * Deploy the Rubrik cluster's global settings — a SINGLETON with five
 * independent read-then-write-if-different steps, each converging on the
 * declared value without a needless write when the cluster already matches:
 *   PATCH /api/v1/cluster/me                          (name, timezone, geolocation)
 *   POST  /api/internal/cluster/me/dns_nameserver         (full replace)
 *   POST  /api/internal/cluster/me/dns_search_domain      (full replace)
 *   POST  /api/internal/cluster/me/ntp_server              (full replace)
 *   PUT   /api/internal/cluster/me/login_banner
 *
 * rollbackData captures every area's PRIOR value (read before its write), even
 * when a later step fails, so rollback restores exactly what this deploy
 * actually changed. A failure partway is reported with which areas were
 * already applied. Verify against a live Rubrik CDM cluster.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }
  if (items.length === 0) {
    return { success: false, message: 'No cluster settings declared.' }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const spec = buildClusterSettingsSpec(items[0].fields)
  const rollbackData: ClusterSettingsRollbackData = {
    clusterName: null,
    timezone: null,
    location: null,
    dnsServers: null,
    dnsSearchDomains: null,
    ntpServers: null,
    loginBanner: null,
  }
  const applied: string[] = []

  try {
    // 1. Identity — name / timezone / geolocation.
    const info = await getJson<RubrikClusterInfo>(conn, '/api/v1/cluster/me')
    rollbackData.clusterName = info.name ?? ''
    rollbackData.timezone = info.timezone?.timezone ?? ''
    rollbackData.location = info.geolocation?.address ?? ''
    const identityChanged =
      (spec.clusterName !== '' && spec.clusterName !== rollbackData.clusterName) ||
      spec.timezone !== rollbackData.timezone ||
      spec.location !== rollbackData.location
    if (identityChanged) {
      await sendJson(conn, 'PATCH', '/api/v1/cluster/me', buildClusterInfoPatch(spec))
    }
    applied.push('identity')

    // 2. DNS nameservers — full replace.
    const dnsServers = stringListFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/dns_nameserver'))
    rollbackData.dnsServers = dnsServers
    if (!stringListsEqual(dnsServers, spec.dnsServers)) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/dns_nameserver', spec.dnsServers)
    }
    applied.push('dns_nameservers')

    // 3. DNS search domains — full replace.
    const dnsSearchDomains = stringListFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/dns_search_domain'))
    rollbackData.dnsSearchDomains = dnsSearchDomains
    if (!stringListsEqual(dnsSearchDomains, spec.dnsSearchDomains)) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/dns_search_domain', spec.dnsSearchDomains)
    }
    applied.push('dns_search_domains')

    // 4. NTP servers — full replace.
    const ntpServers = ntpServersFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/ntp_server'))
    rollbackData.ntpServers = ntpServers
    if (!stringListsEqual(ntpServers, spec.ntpServers)) {
      await sendJson(conn, 'POST', '/api/internal/cluster/me/ntp_server', buildNtpServersBody(spec.ntpServers))
    }
    applied.push('ntp_servers')

    // 5. Login banner.
    const banner = await getJson<LoginBannerResponse>(conn, '/api/internal/cluster/me/login_banner')
    rollbackData.loginBanner = banner.loginBanner ?? ''
    if ((banner.loginBanner ?? '') !== spec.loginBanner) {
      await sendJson(conn, 'PUT', '/api/internal/cluster/me/login_banner', { loginBanner: spec.loginBanner })
    }
    applied.push('login_banner')

    return {
      success: true,
      message: `Applied global cluster settings: ${applied.join(', ')}.`,
      artifacts: { base: conn.base, applied },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Global cluster settings deploy failed after [${applied.join(', ') || 'none'}]: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base, applied },
      rollbackData,
    }
  }
}
