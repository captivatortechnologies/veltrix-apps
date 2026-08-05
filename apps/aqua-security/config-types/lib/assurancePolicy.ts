// =============================================================================
// Shared logic for the four assurance-policy config types (image, host,
// function, kubernetes) — they share ONE wire shape and ONE endpoint family
// (/api/v2/assurance_policy/<type>), differing only in the `<type>` path
// segment and `assurance_type` body field. See lib/aquasec.ts's module doc
// for the endpoint citation. Kept in one file so a shared-field fix (e.g. a
// severity enum correction) lands on all four config types at once.
// =============================================================================

import type { CanvasSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import type { AquaAssurancePolicy, AssuranceType } from '../../lib/aquasec'
import {
  buildScope,
  displayLabels,
  displayList,
  displayScope,
  normalizeBoolean,
  normalizeNumber,
  sameLabels,
  sameScope,
  sameStringSet,
  splitList,
  toLabels,
} from './common'

export const CVSS_SEVERITIES = ['negligible', 'low', 'medium', 'high', 'critical'] as const

export interface AssurancePolicySpec {
  itemId?: string
  name: string
  description: string
  applicationScopes: string[]
  registries: string[]
  enabled: boolean
  enforce: boolean
  blockFailed: boolean
  failCicd: boolean
  auditOnFailure: boolean
  enforceAfterDays: number
  cvssSeverityEnabled: boolean
  cvssSeverity: string
  cvssSeverityExcludeNoFix: boolean
  maximumScoreEnabled: boolean
  maximumScore: number
  maximumScoreExcludeNoFix: boolean
  cvesBlackListEnabled: boolean
  cvesBlackList: string[]
  cvesWhiteListEnabled: boolean
  cvesWhiteList: string[]
  ignoreRecentlyPublishedVln: boolean
  ignoreRecentlyPublishedVlnPeriod: number
  disallowMalware: boolean
  scanSensitiveData: boolean
  packagesBlackListEnabled: boolean
  packagesBlackList: string[]
  whitelistedLicensesEnabled: boolean
  whitelistedLicenses: string[]
  blacklistedLicensesEnabled: boolean
  blacklistedLicenses: string[]
  dockerCisEnabled: boolean
  kubeCisEnabled: boolean
  linuxCisEnabled: boolean
  windowsCisEnabled: boolean
  openshiftHardeningEnabled: boolean
  onlyNoneRootUsers: boolean
  trustedBaseImagesEnabled: boolean
  requiredLabelsEnabled: boolean
  requiredLabels: unknown
  forbiddenLabelsEnabled: boolean
  forbiddenLabels: unknown
  scopeExpression: string
  scopeVariables: unknown
}

/** Extract every assurance-policy item's canvas fields into a typed spec. */
export function extractAssurancePolicySpecs(canvas: CanvasSnapshot): AssurancePolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(f.name ?? '').trim(),
      description: String(f.description ?? '').trim(),
      applicationScopes: splitList(f.applicationScopes),
      registries: splitList(f.registries),
      enabled: normalizeBoolean(f.enabled, true),
      enforce: normalizeBoolean(f.enforce, false),
      blockFailed: normalizeBoolean(f.blockFailed, true),
      failCicd: normalizeBoolean(f.failCicd, true),
      auditOnFailure: normalizeBoolean(f.auditOnFailure, true),
      enforceAfterDays: normalizeNumber(f.enforceAfterDays, 0),
      cvssSeverityEnabled: normalizeBoolean(f.cvssSeverityEnabled, false),
      cvssSeverity: String(f.cvssSeverity ?? 'high').trim(),
      cvssSeverityExcludeNoFix: normalizeBoolean(f.cvssSeverityExcludeNoFix, false),
      maximumScoreEnabled: normalizeBoolean(f.maximumScoreEnabled, false),
      maximumScore: normalizeNumber(f.maximumScore, 7),
      maximumScoreExcludeNoFix: normalizeBoolean(f.maximumScoreExcludeNoFix, false),
      cvesBlackListEnabled: normalizeBoolean(f.cvesBlackListEnabled, false),
      cvesBlackList: splitList(f.cvesBlackList),
      cvesWhiteListEnabled: normalizeBoolean(f.cvesWhiteListEnabled, false),
      cvesWhiteList: splitList(f.cvesWhiteList),
      ignoreRecentlyPublishedVln: normalizeBoolean(f.ignoreRecentlyPublishedVln, false),
      ignoreRecentlyPublishedVlnPeriod: normalizeNumber(f.ignoreRecentlyPublishedVlnPeriod, 0),
      disallowMalware: normalizeBoolean(f.disallowMalware, false),
      scanSensitiveData: normalizeBoolean(f.scanSensitiveData, false),
      packagesBlackListEnabled: normalizeBoolean(f.packagesBlackListEnabled, false),
      packagesBlackList: splitList(f.packagesBlackList),
      whitelistedLicensesEnabled: normalizeBoolean(f.whitelistedLicensesEnabled, false),
      whitelistedLicenses: splitList(f.whitelistedLicenses),
      blacklistedLicensesEnabled: normalizeBoolean(f.blacklistedLicensesEnabled, false),
      blacklistedLicenses: splitList(f.blacklistedLicenses),
      dockerCisEnabled: normalizeBoolean(f.dockerCisEnabled, false),
      kubeCisEnabled: normalizeBoolean(f.kubeCisEnabled, false),
      linuxCisEnabled: normalizeBoolean(f.linuxCisEnabled, false),
      windowsCisEnabled: normalizeBoolean(f.windowsCisEnabled, false),
      openshiftHardeningEnabled: normalizeBoolean(f.openshiftHardeningEnabled, false),
      onlyNoneRootUsers: normalizeBoolean(f.onlyNoneRootUsers, false),
      trustedBaseImagesEnabled: normalizeBoolean(f.trustedBaseImagesEnabled, false),
      requiredLabelsEnabled: normalizeBoolean(f.requiredLabelsEnabled, false),
      requiredLabels: f.requiredLabels,
      forbiddenLabelsEnabled: normalizeBoolean(f.forbiddenLabelsEnabled, false),
      forbiddenLabels: f.forbiddenLabels,
      scopeExpression: String(f.scopeExpression ?? '').trim(),
      scopeVariables: f.scopeVariables,
    }
  })
}

/** Build the Aqua assurance-policy wire body from a spec, for the given assurance type. */
export function buildAssurancePolicyBody(spec: AssurancePolicySpec, type: AssuranceType): AquaAssurancePolicy {
  return {
    name: spec.name,
    assurance_type: type,
    description: spec.description,
    application_scopes: spec.applicationScopes.length ? spec.applicationScopes : ['Global'],
    registries: spec.registries,
    enabled: spec.enabled,
    enforce: spec.enforce,
    block_failed: spec.blockFailed,
    fail_cicd: spec.failCicd,
    audit_on_failure: spec.auditOnFailure,
    enforce_after_days: spec.enforceAfterDays,
    cvss_severity_enabled: spec.cvssSeverityEnabled,
    cvss_severity: spec.cvssSeverity,
    cvss_severity_exclude_no_fix: spec.cvssSeverityExcludeNoFix,
    maximum_score_enabled: spec.maximumScoreEnabled,
    maximum_score: spec.maximumScore,
    maximum_score_exclude_no_fix: spec.maximumScoreExcludeNoFix,
    cves_black_list_enabled: spec.cvesBlackListEnabled,
    cves_black_list: spec.cvesBlackList,
    cves_white_list_enabled: spec.cvesWhiteListEnabled,
    cves_white_list: spec.cvesWhiteList,
    ignore_recently_published_vln: spec.ignoreRecentlyPublishedVln,
    ignore_recently_published_vln_period: spec.ignoreRecentlyPublishedVlnPeriod,
    disallow_malware: spec.disallowMalware,
    scan_sensitive_data: spec.scanSensitiveData,
    packages_black_list_enabled: spec.packagesBlackListEnabled,
    packages_black_list: spec.packagesBlackList.map((name) => ({ name })),
    whitelisted_licenses_enabled: spec.whitelistedLicensesEnabled,
    whitelisted_licenses: spec.whitelistedLicenses,
    blacklisted_licenses_enabled: spec.blacklistedLicensesEnabled,
    blacklisted_licenses: spec.blacklistedLicenses,
    docker_cis_enabled: spec.dockerCisEnabled,
    kube_cis_enabled: spec.kubeCisEnabled,
    linux_cis_enabled: spec.linuxCisEnabled,
    windows_cis_enabled: spec.windowsCisEnabled,
    openshift_hardening_enabled: spec.openshiftHardeningEnabled,
    only_none_root_users: spec.onlyNoneRootUsers,
    trusted_base_images_enabled: spec.trustedBaseImagesEnabled,
    required_labels_enabled: spec.requiredLabelsEnabled,
    required_labels: toLabels(spec.requiredLabels),
    forbidden_labels_enabled: spec.forbiddenLabelsEnabled,
    forbidden_labels: toLabels(spec.forbiddenLabels),
    scope: buildScope(spec.scopeExpression, spec.scopeVariables),
  }
}

/** Diff a declared spec against the live policy Aqua returned. Read-only, best-effort. */
export function diffAssurancePolicy(spec: AssurancePolicySpec, live: AquaAssurancePolicy): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const push = (field: string, expected: unknown, actual: unknown, severity: DriftDiff['severity'] = 'warning') => {
    diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity })
  }

  if (spec.enabled !== (live.enabled ?? true)) push('enabled', spec.enabled, live.enabled ?? true, 'critical')
  if (spec.enforce !== Boolean(live.enforce)) push('enforce', spec.enforce, Boolean(live.enforce), 'critical')
  if (spec.blockFailed !== Boolean(live.block_failed)) push('blockFailed', spec.blockFailed, Boolean(live.block_failed))
  if (spec.auditOnFailure !== Boolean(live.audit_on_failure)) push('auditOnFailure', spec.auditOnFailure, Boolean(live.audit_on_failure))

  const declaredScopes = displayList(spec.applicationScopes.length ? spec.applicationScopes : ['Global'])
  const actualScopes = displayList(live.application_scopes)
  if (declaredScopes !== actualScopes) push('applicationScopes', declaredScopes, actualScopes, 'critical')

  if (spec.cvssSeverityEnabled !== Boolean(live.cvss_severity_enabled)) {
    push('cvssSeverityEnabled', spec.cvssSeverityEnabled, Boolean(live.cvss_severity_enabled))
  } else if (spec.cvssSeverityEnabled && spec.cvssSeverity !== (live.cvss_severity ?? '')) {
    push('cvssSeverity', spec.cvssSeverity, live.cvss_severity ?? '')
  }

  if (spec.maximumScoreEnabled !== Boolean(live.maximum_score_enabled)) {
    push('maximumScoreEnabled', spec.maximumScoreEnabled, Boolean(live.maximum_score_enabled))
  } else if (spec.maximumScoreEnabled && spec.maximumScore !== (live.maximum_score ?? 0)) {
    push('maximumScore', spec.maximumScore, live.maximum_score ?? 0)
  }

  if (spec.disallowMalware !== Boolean(live.disallow_malware)) push('disallowMalware', spec.disallowMalware, Boolean(live.disallow_malware))
  if (spec.scanSensitiveData !== Boolean(live.scan_sensitive_data)) push('scanSensitiveData', spec.scanSensitiveData, Boolean(live.scan_sensitive_data))

  const declaredCves = displayList(spec.cvesBlackListEnabled ? spec.cvesBlackList : [])
  const actualCves = displayList(live.cves_black_list_enabled ? live.cves_black_list : [])
  if (declaredCves !== actualCves) push('cvesBlackList', declaredCves, actualCves)

  for (const [key, expected, actualRaw] of [
    ['dockerCisEnabled', spec.dockerCisEnabled, live.docker_cis_enabled],
    ['kubeCisEnabled', spec.kubeCisEnabled, live.kube_cis_enabled],
    ['linuxCisEnabled', spec.linuxCisEnabled, live.linux_cis_enabled],
    ['windowsCisEnabled', spec.windowsCisEnabled, live.windows_cis_enabled],
    ['openshiftHardeningEnabled', spec.openshiftHardeningEnabled, live.openshift_hardening_enabled],
    ['onlyNoneRootUsers', spec.onlyNoneRootUsers, live.only_none_root_users],
    ['trustedBaseImagesEnabled', spec.trustedBaseImagesEnabled, live.trusted_base_images_enabled],
  ] as const) {
    const actual = Boolean(actualRaw)
    if (expected !== actual) push(key, expected, actual)
  }

  const declaredRequired = displayLabels(spec.requiredLabelsEnabled ? toLabels(spec.requiredLabels) : [])
  const actualRequired = displayLabels(live.required_labels_enabled ? live.required_labels : [])
  if (declaredRequired !== actualRequired) push('requiredLabels', declaredRequired, actualRequired)

  const declaredForbidden = displayLabels(spec.forbiddenLabelsEnabled ? toLabels(spec.forbiddenLabels) : [])
  const actualForbidden = displayLabels(live.forbidden_labels_enabled ? live.forbidden_labels : [])
  if (declaredForbidden !== actualForbidden) push('forbiddenLabels', declaredForbidden, actualForbidden)

  const declaredScope = buildScope(spec.scopeExpression, spec.scopeVariables)
  if (!sameScope(declaredScope, live.scope)) push('scope', displayScope(declaredScope), displayScope(live.scope))

  return diffs
}

export { sameStringSet }
