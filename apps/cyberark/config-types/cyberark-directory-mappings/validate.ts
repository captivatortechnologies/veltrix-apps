import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parsePositiveInt, readStringList } from '../../lib/cyberark'

// =============================================================================
// CyberArk LDAP Directory Mappings — validate + shared spec extraction.
//
// A directory mapping maps an LDAP/AD group onto Vault groups + authorizations
// for an EXISTING LDAP directory (identified here by its human-readable
// DirectoryName, resolved to CyberArk's internal directory id at deploy
// time). CyberArk assigns a numeric MappingID, so reconciliation uses the
// natural key: (DirectoryName, MappingName).
//
// ⚠ OUT OF SCOPE — creating/updating the LDAP DIRECTORY ITSELF
// (`POST/DELETE .../Configuration/LDAP/Directories`) is intentionally NOT
// covered by this app: creating a directory requires a `BindPassword` (the
// service account CyberArk uses to query the directory) — genuine secret
// material this app does not handle. An operator provisions the directory
// once (PVWA UI or the Directories API directly); THIS type only manages the
// group→authorization mappings hung off it, which carry no secret at all.
//
// Reordering mappings (`POST .../Mappings/Reorder`) is also out of scope: it
// requires submitting the FULL ordered list of every mapping id in the
// directory, including any this app doesn't manage — calling it could
// silently reorder or displace mappings outside this app's scope.
// =============================================================================

export interface DirectoryMappingSpec {
  sectionName: string
  directoryName: string
  mappingName: string
  domainGroups: string[]
  ldapBranch: string
  vaultGroups: string[]
  mappingAuthorizations: string[]
  location: string
  authenticationMethod: string[]
  userType: string
  disableUser: boolean
  userActivityLogPeriod: number | null
  userExpiration: number | null
  logonFromHour: number | null
  logonToHour: number | null
}

/** Shape of a directory returned by GET /Configuration/LDAP/Directories/ (only fields we read). */
export interface LiveDirectory {
  DirectoryName?: string
  Name?: string
  id?: string | number
  DirectoryID?: string | number
  LDAPID?: string | number
}

/** Shape of a mapping returned by GET .../Directories/{id}/Mappings (only fields we manage). */
export interface LiveDirectoryMapping {
  MappingID?: string | number
  MappingName?: string
  LDAPBranch?: string
  DomainGroups?: string[]
  VaultGroups?: string[]
  MappingAuthorizations?: string[]
  Location?: string
  AuthenticationMethod?: string[]
  UserType?: string
  DisableUser?: boolean | string
  UserActivityLogPeriod?: number
  UserExpiration?: number
  LogonFromHour?: number
  LogonToHour?: number
}

/** A mapping's natural key — (DirectoryName, MappingName), both lower-cased. */
export function mappingKey(spec: { directoryName: string; mappingName: string }): string {
  return JSON.stringify([spec.directoryName.trim().toLowerCase(), spec.mappingName.trim().toLowerCase()])
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one LDAP directory mapping. */
export function extractDirectoryMappingSpecs(canvas: CanvasSnapshot): DirectoryMappingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      directoryName: typeof fields.directory_name === 'string' ? fields.directory_name.trim() : '',
      mappingName: typeof fields.mapping_name === 'string' ? fields.mapping_name.trim() : '',
      domainGroups: readStringList(fields.domain_groups),
      ldapBranch: typeof fields.ldap_branch === 'string' ? fields.ldap_branch.trim() : '',
      vaultGroups: readStringList(fields.vault_groups),
      mappingAuthorizations: readStringList(fields.mapping_authorizations),
      location: typeof fields.location === 'string' && fields.location.trim() ? fields.location.trim() : '\\',
      authenticationMethod: readStringList(fields.authentication_method),
      userType: typeof fields.user_type === 'string' ? fields.user_type.trim() : '',
      disableUser: readBool(fields.disable_user, false),
      userActivityLogPeriod: parsePositiveInt(fields.user_activity_log_period).value,
      userExpiration: parsePositiveInt(fields.user_expiration).value,
      logonFromHour: parseHour(fields.logon_from_hour),
      logonToHour: parseHour(fields.logon_to_hour),
    }
  })
}

function parseHour(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate directory-mapping configurations: directory name, mapping name and
 * at least one domain group are required; hour fields (when set) must be
 * 0-23; the user-activity-log period (when set) is a positive number of days;
 * the (directory, mapping name) natural key is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDirectoryMappingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.directoryName) errors.push({ field: `${prefix}.directory_name`, message: 'Directory name is required', code: 'required' })
    if (!spec.mappingName) errors.push({ field: `${prefix}.mapping_name`, message: 'Mapping name is required', code: 'required' })
    if (spec.domainGroups.length === 0) {
      errors.push({ field: `${prefix}.domain_groups`, message: 'At least one domain group is required', code: 'required' })
    }

    for (const [field, value] of [
      ['logon_from_hour', spec.logonFromHour],
      ['logon_to_hour', spec.logonToHour],
    ] as const) {
      if (value !== null && (value < 0 || value > 23)) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must be between 0 and 23`, code: 'invalid_hour' })
      }
    }

    const logPeriod = parsePositiveInt((sections.find((s) => s.name === prefix)?.fields ?? {}).user_activity_log_period)
    if (logPeriod.error) {
      errors.push({ field: `${prefix}.user_activity_log_period`, message: `User activity log period ${logPeriod.error}`, code: 'invalid_log_period' })
    }

    if (spec.directoryName && spec.mappingName) {
      const key = mappingKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.mapping_name`,
          message: `Duplicate mapping "${spec.mappingName}" in directory "${spec.directoryName}" — each (directory, mapping name) may only be declared once`,
          code: 'duplicate_mapping',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
