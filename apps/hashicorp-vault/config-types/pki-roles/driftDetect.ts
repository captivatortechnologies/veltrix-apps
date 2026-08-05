import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getPkiRole } from './deploy'
import { extractPkiRoleSpecs, roleKey, type PkiRoleSpec } from './validate'

/**
 * Detect drift between the deployed PKI role configuration and the live
 * cluster. Re-reads each role via GET {mount}/roles/{name} and diffs every
 * field this config type MANAGES (see buildRoleBody in deploy.ts) — a field
 * Vault's role schema defines but this canvas never sets (e.g.
 * policy_identifiers) is intentionally not compared, since this app never
 * writes it either way.
 *
 * A missing role is `critical`. Every managed-field mismatch is `warning` — it
 * converges on the next deploy (a full role rewrite, per deploy.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPkiRoleSpecs(ctx.deployedConfig).filter((s) => s.mount && s.name)

  for (const spec of specs) {
    const key = roleKey(spec.mount, spec.name)
    try {
      const live = await getPkiRole(client, spec.mount, spec.name)

      if (!live) {
        diffs.push({ field: key, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      for (const [field, expected, actual] of diffableFields(spec, live)) {
        if (expected !== actual) {
          diffs.push({ field: `${key}.${field}`, expected, actual, severity: 'warning' })
        }
      }
    } catch (error) {
      diffs.push({
        field: key,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** The [fieldLabel, expected, actual] triples to compare, stringified for a stable diff. */
function diffableFields(spec: PkiRoleSpec, live: Record<string, unknown>): Array<[string, string, string]> {
  const rows: Array<[string, string, string]> = []
  const bool = (field: string, expected: boolean, key: string) => {
    rows.push([field, String(expected), String(live[key] === true)])
  }
  const list = (field: string, expected: string[], key: string) => {
    const liveList = Array.isArray(live[key]) ? (live[key] as unknown[]).map((v) => String(v)) : []
    rows.push([field, sortedCsv(expected), sortedCsv(liveList)])
  }
  const optStr = (field: string, expected: string | undefined, key: string) => {
    if (expected === undefined) return
    rows.push([field, expected, str(live[key])])
  }
  const optNum = (field: string, expected: number | undefined, key: string) => {
    if (expected === undefined) return
    rows.push([field, String(expected), num(live[key])])
  }

  optStr('ttl', spec.ttl, 'ttl')
  optStr('maxTtl', spec.maxTtl, 'max_ttl')
  optStr('keyType', spec.keyType, 'key_type')
  optNum('keyBits', spec.keyBits, 'key_bits')
  list('keyUsage', spec.keyUsage, 'key_usage')
  optStr('notBeforeDuration', spec.notBeforeDuration, 'not_before_duration')
  optStr('issuerRef', spec.issuerRef, 'issuer_ref')

  list('allowedDomains', spec.allowedDomains, 'allowed_domains')
  bool('allowBareDomains', spec.allowBareDomains, 'allow_bare_domains')
  bool('allowSubdomains', spec.allowSubdomains, 'allow_subdomains')
  bool('allowGlobDomains', spec.allowGlobDomains, 'allow_glob_domains')
  bool('allowWildcardCertificates', spec.allowWildcardCertificates, 'allow_wildcard_certificates')
  bool('allowLocalhost', spec.allowLocalhost, 'allow_localhost')
  bool('allowAnyName', spec.allowAnyName, 'allow_any_name')
  bool('enforceHostnames', spec.enforceHostnames, 'enforce_hostnames')
  bool('allowIpSans', spec.allowIpSans, 'allow_ip_sans')

  bool('serverFlag', spec.serverFlag, 'server_flag')
  bool('clientFlag', spec.clientFlag, 'client_flag')
  bool('codeSigningFlag', spec.codeSigningFlag, 'code_signing_flag')
  bool('requireCn', spec.requireCn, 'require_cn')
  bool('useCsrCommonName', spec.useCsrCommonName, 'use_csr_common_name')
  bool('noStore', spec.noStore, 'no_store')
  bool('generateLease', spec.generateLease, 'generate_lease')

  return rows
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function num(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return String(Number(value))
  return ''
}

function sortedCsv(values: string[]): string {
  return [...values].sort().join(',')
}
