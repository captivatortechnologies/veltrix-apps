import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractIpReputationSpec, getIpReputation } from './validate'

const BOOL_FIELDS = [
  ['enabled', 'enabled'],
  ['block_tor_nodes', 'blockTorNodes'],
  ['block_anonymous_proxies', 'blockAnonymousProxies'],
  ['block_satellite_providers', 'blockSatelliteProviders'],
  ['block_unclassified_ips', 'blockUnclassifiedIps'],
  ['block_ssh_attack_sources', 'blockSshAttackSources'],
  ['block_datacenter_ip', 'blockDatacenterIp'],
  ['block_public_proxy', 'blockPublicProxy'],
  ['block_http_attack_sources', 'blockHttpAttackSources'],
  ['block_fake_crawler', 'blockFakeCrawler'],
  ['check_registered_country', 'checkRegisteredCountry'],
  ['geoip_enable_logging', 'geoipEnableLogging'],
] as const

/** Detect drift between the deployed IP Reputation object and the live Application. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const sections = ctx.deployedConfig.sections ?? []
  if (sections.length === 0) return { hasDrift: false, diffs: [] }
  const spec = extractIpReputationSpec(ctx.deployedConfig)

  try {
    const live = await getIpReputation(client, appName)

    for (const [field, key] of BOOL_FIELDS) {
      const liveVal = (live as Record<string, unknown>)[field]
      const expected = (spec as unknown as Record<string, unknown>)[key]
      if ((liveVal ?? false) !== expected) {
        diffs.push({ field, expected, actual: liveVal ?? false, severity: field === 'enabled' ? 'critical' : 'warning' })
      }
    }

    if ((live.apply_policy_at ?? '') !== spec.applyPolicyAt) {
      diffs.push({ field: 'apply_policy_at', expected: spec.applyPolicyAt, actual: live.apply_policy_at ?? 'not set', severity: 'warning' })
    }

    const liveCountries = [...(live.blocked_countries ?? [])].sort()
    const expectedCountries = [...spec.blockedCountries].sort()
    if (JSON.stringify(liveCountries) !== JSON.stringify(expectedCountries)) {
      diffs.push({
        field: 'blocked_countries',
        expected: expectedCountries.join(', ') || 'none',
        actual: liveCountries.join(', ') || 'none',
        severity: 'warning',
      })
    }

    const liveExceptionCount = (live.exceptions ?? []).length
    if (liveExceptionCount !== spec.exceptions.length) {
      diffs.push({
        field: 'exceptions',
        expected: `${spec.exceptions.length} exception(s)`,
        actual: `${liveExceptionCount} exception(s)`,
        severity: 'warning',
      })
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
