// =============================================================================
// Shared "attack type" severity fields — identical sub-shape on both
// Parameter Protection (`/applications/{appName}/parameter_protection/`) and
// URL Protection (`/applications/{appName}/url_protection/`), per the live
// Barracuda WAF-as-a-Service v4 OpenAPI schema (api.waas.barracudanetworks.com
// /v4/swagger/, schemas ParameterProtection / UrlProtectionResponseSchema).
//
// Each attack type is a STRING field (not boolean) — the API's own examples
// use "normal" and "none"; a third "strict" tier is not directly evidenced on
// these two string fields, but IS confirmed as a real severity tier elsewhere
// in the same API version (Header Allow Deny rules carry paired
// `block_<type>` / `block_<type>_strict` booleans). Rather than lock the
// canvas to a closed enum this app cannot fully verify, these are modeled as
// free-text fields with the two directly-observed values documented in
// helpText — see each config type's canvas.yaml.
// =============================================================================

export interface AttackTypeSettings {
  sqlInjection: string
  osCommandInjection: string
  crossSiteScripting: string
  remoteFileInclusion: string
  ldapInjection: string
  pythonPhpAttacks: string
  httpSpecificInjection: string
  apacheStrutsAttacks: string
  directoryTraversal: string
  customBlockedAttackTypeGroups: string[]
}

/** Read the attack-type fields out of a flat canvas item's fields (shared field keys). */
export function readAttackTypeSettings(fields: Record<string, unknown>): AttackTypeSettings {
  return {
    sqlInjection: readSeverity(fields.sql_injection),
    osCommandInjection: readSeverity(fields.os_command_injection),
    crossSiteScripting: readSeverity(fields.cross_site_scripting),
    remoteFileInclusion: readSeverity(fields.remote_file_inclusion),
    ldapInjection: readSeverity(fields.ldap_injection),
    pythonPhpAttacks: readSeverity(fields.python_php_attacks),
    httpSpecificInjection: readSeverity(fields.http_specific_injection),
    apacheStrutsAttacks: readSeverity(fields.apache_struts_attacks),
    directoryTraversal: readSeverity(fields.directory_traversal),
    customBlockedAttackTypeGroups: readTagList(fields.custom_blocked_attack_type_groups),
  }
}

/** Build the wire-shape (snake_case) body fragment for the attack-type fields. */
export function buildAttackTypeBody(spec: AttackTypeSettings): Record<string, unknown> {
  return {
    sql_injection: spec.sqlInjection,
    os_command_injection: spec.osCommandInjection,
    cross_site_scripting: spec.crossSiteScripting,
    remote_file_inclusion: spec.remoteFileInclusion,
    ldap_injection: spec.ldapInjection,
    python_php_attacks: spec.pythonPhpAttacks,
    http_specific_injection: spec.httpSpecificInjection,
    apache_struts_attacks: spec.apacheStrutsAttacks,
    directory_traversal: spec.directoryTraversal,
    custom_blocked_attack_type_groups: spec.customBlockedAttackTypeGroups,
  }
}

/** Read the attack-type fields back out of a live API response object. */
export function readLiveAttackTypeSettings(live: Record<string, unknown>): AttackTypeSettings {
  return readAttackTypeSettings(live)
}

/** Diff every attack-type field between a declared spec and the live object; pushes into `diffs`. */
export function diffAttackTypeSettings(
  expected: AttackTypeSettings,
  actual: AttackTypeSettings,
  diffs: Array<{ field: string; expected: unknown; actual: unknown; severity: 'info' | 'warning' | 'critical' }>,
): void {
  const pairs: Array<[string, keyof AttackTypeSettings]> = [
    ['sql_injection', 'sqlInjection'],
    ['os_command_injection', 'osCommandInjection'],
    ['cross_site_scripting', 'crossSiteScripting'],
    ['remote_file_inclusion', 'remoteFileInclusion'],
    ['ldap_injection', 'ldapInjection'],
    ['python_php_attacks', 'pythonPhpAttacks'],
    ['http_specific_injection', 'httpSpecificInjection'],
    ['apache_struts_attacks', 'apacheStrutsAttacks'],
    ['directory_traversal', 'directoryTraversal'],
  ]
  for (const [field, key] of pairs) {
    if (expected[key] !== actual[key]) {
      diffs.push({ field, expected: expected[key] || 'not set', actual: actual[key] || 'not set', severity: 'warning' })
    }
  }
  const expectedGroups = [...expected.customBlockedAttackTypeGroups].sort()
  const actualGroups = [...actual.customBlockedAttackTypeGroups].sort()
  if (JSON.stringify(expectedGroups) !== JSON.stringify(actualGroups)) {
    diffs.push({
      field: 'custom_blocked_attack_type_groups',
      expected: expectedGroups.join(', ') || 'none',
      actual: actualGroups.join(', ') || 'none',
      severity: 'info',
    })
  }
}

function readSeverity(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'none'
}

function readTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
}
