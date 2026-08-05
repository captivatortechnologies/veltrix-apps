import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asArray, barracudaErrorMessage, readBool, readString, readStringList, type BarracudaWaasClient } from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service Header Allow/Deny Rules constraints ----------
//
// This config type manages the RULES sub-collection only:
//   GET/POST              /applications/{appName}/headers_allow_deny/rules/       (list, create)
//   GET/PATCH/PUT/DELETE   /applications/{appName}/headers_allow_deny/rules/{name}/ (both paths carry a trailing slash)
// The PARENT singleton resource /applications/{appName}/headers_allow_deny/
// also carries a master `enabled` boolean gating the whole feature (wire
// shape `{rules: [...], enabled: bool}`) — that master toggle is OUT OF SCOPE
// for this config type; only the individual named rules under /rules/ are
// managed here (see README Coverage). Every field name below is confirmed
// directly against the live API's request-body example
// (api.waas.barracudanetworks.com/v4/swagger/, "Add a Header Allow Deny
// rule"). Identity for reconciliation is the rule `name`, used directly in
// the URL (no separate server-assigned id, same convention as Traffic Rules).

export interface HeaderRuleSpec {
  sectionName: string
  name: string
  headerName: string
  enabled: boolean
  active: boolean
  maxHeaderValueLength: number | null
  deniedMetacharacters: string
  blockSqlInjection: boolean
  blockOsCommandInjection: boolean
  blockDirectoryTraversal: boolean
  blockCrossSiteScripting: boolean
  blockRemoteFileInclusion: boolean
  blockSqlInjectionStrict: boolean
  blockOsCommandInjectionStrict: boolean
  blockDirectoryTraversalStrict: boolean
  blockCrossSiteScriptingStrict: boolean
  blockRemoteFileInclusionStrict: boolean
  blockLdapInjection: boolean
  blockPythonPhpAttacks: boolean
  blockHttpSpecificInjection: boolean
  blockApacheStrutsAttacks: boolean
  blockApacheStrutsAttacksStrict: boolean
  comments: string | null
  exceptionPatterns: string[]
  customBlockedAttackTypeGroups: string[]
}

function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}

function readNullableString(value: unknown): string | null {
  const s = readString(value)
  return s ? s : null
}

/** Each canvas item describes one Header Allow/Deny rule. */
export function extractHeaderRuleSpecs(canvas: CanvasSnapshot): HeaderRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      headerName: readString(fields.header_name),
      enabled: readBool(fields.enabled, true),
      active: readBool(fields.active, true),
      maxHeaderValueLength: readNullableNumber(fields.max_header_value_length),
      deniedMetacharacters: readString(fields.denied_metacharacters),
      blockSqlInjection: readBool(fields.block_sql_injection, false),
      blockOsCommandInjection: readBool(fields.block_os_command_injection, false),
      blockDirectoryTraversal: readBool(fields.block_directory_traversal, false),
      blockCrossSiteScripting: readBool(fields.block_cross_site_scripting, false),
      blockRemoteFileInclusion: readBool(fields.block_remote_file_inclusion, false),
      blockSqlInjectionStrict: readBool(fields.block_sql_injection_strict, false),
      blockOsCommandInjectionStrict: readBool(fields.block_os_command_injection_strict, false),
      blockDirectoryTraversalStrict: readBool(fields.block_directory_traversal_strict, false),
      blockCrossSiteScriptingStrict: readBool(fields.block_cross_site_scripting_strict, false),
      blockRemoteFileInclusionStrict: readBool(fields.block_remote_file_inclusion_strict, false),
      blockLdapInjection: readBool(fields.block_ldap_injection, false),
      blockPythonPhpAttacks: readBool(fields.block_python_php_attacks, false),
      blockHttpSpecificInjection: readBool(fields.block_http_specific_injection, false),
      blockApacheStrutsAttacks: readBool(fields.block_apache_struts_attacks, false),
      blockApacheStrutsAttacksStrict: readBool(fields.block_apache_struts_attacks_strict, false),
      comments: readNullableString(fields.comments),
      exceptionPatterns: readStringList(fields.exception_patterns),
      customBlockedAttackTypeGroups: readStringList(fields.custom_blocked_attack_type_groups),
    }
  })
}

/** The rule's identity key — its name. */
export function headerRuleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Shape of a rule returned by GET /applications/{appName}/headers_allow_deny/rules/. */
export interface LiveHeaderRule {
  name?: string
  header_name?: string
  enabled?: boolean
  active?: boolean
  max_header_value_length?: number | null
  denied_metacharacters?: string | null
  block_sql_injection?: boolean
  block_os_command_injection?: boolean
  block_directory_traversal?: boolean
  block_cross_site_scripting?: boolean
  block_remote_file_inclusion?: boolean
  block_sql_injection_strict?: boolean
  block_os_command_injection_strict?: boolean
  block_directory_traversal_strict?: boolean
  block_cross_site_scripting_strict?: boolean
  block_remote_file_inclusion_strict?: boolean
  block_ldap_injection?: boolean
  block_python_php_attacks?: boolean
  block_http_specific_injection?: boolean
  block_apache_struts_attacks?: boolean
  block_apache_struts_attacks_strict?: boolean
  comments?: string | null
  exception_patterns?: string[]
  custom_blocked_attack_type_groups?: string[]
}

/** Build the POST/PUT request body for a declared Header Allow/Deny rule. */
export function buildHeaderRuleBody(spec: HeaderRuleSpec): LiveHeaderRule {
  return {
    name: spec.name,
    header_name: spec.headerName,
    enabled: spec.enabled,
    active: spec.active,
    max_header_value_length: spec.maxHeaderValueLength,
    denied_metacharacters: spec.deniedMetacharacters,
    block_sql_injection: spec.blockSqlInjection,
    block_os_command_injection: spec.blockOsCommandInjection,
    block_directory_traversal: spec.blockDirectoryTraversal,
    block_cross_site_scripting: spec.blockCrossSiteScripting,
    block_remote_file_inclusion: spec.blockRemoteFileInclusion,
    block_sql_injection_strict: spec.blockSqlInjectionStrict,
    block_os_command_injection_strict: spec.blockOsCommandInjectionStrict,
    block_directory_traversal_strict: spec.blockDirectoryTraversalStrict,
    block_cross_site_scripting_strict: spec.blockCrossSiteScriptingStrict,
    block_remote_file_inclusion_strict: spec.blockRemoteFileInclusionStrict,
    block_ldap_injection: spec.blockLdapInjection,
    block_python_php_attacks: spec.blockPythonPhpAttacks,
    block_http_specific_injection: spec.blockHttpSpecificInjection,
    block_apache_struts_attacks: spec.blockApacheStrutsAttacks,
    block_apache_struts_attacks_strict: spec.blockApacheStrutsAttacksStrict,
    comments: spec.comments,
    exception_patterns: spec.exceptionPatterns,
    custom_blocked_attack_type_groups: spec.customBlockedAttackTypeGroups,
  }
}

/** List every Header Allow/Deny rule on the Application (follows pagination); throws on a non-OK response. */
export async function listHeaderRules(client: BarracudaWaasClient, appName: string): Promise<LiveHeaderRule[]> {
  const res = await client.listAll<LiveHeaderRule>(`${client.appPath(appName)}/headers_allow_deny/rules/`)
  if (!res.ok) throw new Error(`Failed to list Header Allow/Deny rules: ${barracudaErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  return res.items.length ? res.items : asArray<LiveHeaderRule>(res.body)
}

/** Path to a single Header Allow/Deny rule by name (trailing slash — see module doc). */
export function headerRulePath(client: BarracudaWaasClient, appName: string, name: string): string {
  return `${client.appPath(appName)}/headers_allow_deny/rules/${encodeURIComponent(name)}/`
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Header Allow/Deny rules: the name is required and unique across
 * the canvas; header_name (which HTTP header the rule inspects) is required;
 * when set, max_header_value_length must be a non-negative integer.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHeaderRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = headerRuleKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate rule name "${spec.name}" — each rule may only be declared once`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (!spec.headerName) {
      errors.push({ field: `${prefix}.header_name`, message: 'Header Name is required', code: 'required' })
    }

    if (spec.maxHeaderValueLength !== null && (!Number.isInteger(spec.maxHeaderValueLength) || spec.maxHeaderValueLength < 0)) {
      errors.push({
        field: `${prefix}.max_header_value_length`,
        message: 'Max Header Value Length must be a non-negative integer, or blank for no limit',
        code: 'invalid_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
