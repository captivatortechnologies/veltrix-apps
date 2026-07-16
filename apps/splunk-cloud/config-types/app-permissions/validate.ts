import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'

// --- ACS app-permissions constraints (ACS permissions/apps) ------------------
//
// ACS manages which roles may READ (see/run) and WRITE (edit) each installed
// app on a Splunk Cloud stack. Permissions are declarative: a PATCH sends the
// FULL desired read[]/write[] role arrays for one app and REPLACES that app's
// current assignment.
// Docs: /adminconfig/v2/permissions/apps (Victoria Experience only; sc_admin).

/** ACS app-permissions collection endpoint. */
export const PERMISSIONS_APPS_PATH = '/permissions/apps'

/** Endpoint for one app's permissions: /permissions/apps/{app-name}. */
export function appPermissionsPath(appName: string): string {
  return `${PERMISSIONS_APPS_PATH}/${encodeURIComponent(appName)}`
}

/** App ids appear in ACS URLs and match Splunk's app-folder naming. */
export const APP_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/
export const MAX_APP_NAME_LENGTH = 100

/** Splunk role names are lowercase; `*` is the special "all roles" wildcard. */
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
export const ALL_ROLES = '*'

/** Roles broad enough that granting WRITE warrants a least-privilege warning. */
export const BROAD_WRITE_ROLES = new Set<string>(['user', ALL_ROLES])

/** True for a valid Splunk role name or the `*` all-roles wildcard. */
export function isValidRoleName(role: string): boolean {
  return role === ALL_ROLES || ROLE_NAME_RE.test(role)
}

export interface AppPermissionSpec {
  sectionName: string
  appName: string
  readRoles: string[]
  writeRoles: string[]
}

/** Each canvas section declares the read/write roles for ONE installed app. */
export function extractAppPermissionSpecs(canvas: CanvasSnapshot): AppPermissionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      appName: typeof fields.appName === 'string' ? fields.appName.trim() : '',
      readRoles: splitList(fields.readRoles),
      writeRoles: splitList(fields.writeRoles),
    }
  })
}

/**
 * Validate app-permission rules against Splunk's model: a valid app name, at
 * least one read or write role, Splunk role-name format, no duplicate app
 * entries, and least-privilege warnings for granting write to broad roles.
 *
 * Never touches the network — the ACS prerequisites (Victoria Experience, the
 * sc_admin role, an app that is actually installed) are surfaced at
 * deploy/health-check time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no app-permission entries', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenApps = new Set<string>()

  for (const spec of extractAppPermissionSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    // --- App name -----------------------------------------------------------
    if (!spec.appName) {
      errors.push({ field: `${prefix}.appName`, message: 'App name is required', code: 'required' })
    } else {
      if (!APP_NAME_RE.test(spec.appName)) {
        errors.push({
          field: `${prefix}.appName`,
          message:
            'App name must start with a letter and contain only letters, digits, ".", "_" and "-" — it is the installed app\'s id',
          code: 'invalid_format',
        })
      }
      if (spec.appName.length > MAX_APP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.appName`,
          message: `App name must be ${MAX_APP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (seenApps.has(spec.appName)) {
        errors.push({
          field: `${prefix}.appName`,
          message: `Duplicate app "${spec.appName}" — declare each app's read/write roles in a single entry`,
          code: 'duplicate_app',
        })
      }
      seenApps.add(spec.appName)
    }

    // --- Roles --------------------------------------------------------------
    validateRoleList(spec.readRoles, `${prefix}.readRoles`, false, errors, warnings)
    validateRoleList(spec.writeRoles, `${prefix}.writeRoles`, true, errors, warnings)

    // At least one read or write role must be granted, or the entry does nothing.
    if (spec.readRoles.length === 0 && spec.writeRoles.length === 0) {
      errors.push({
        field: `${prefix}.readRoles`,
        message: 'Grant at least one read or write role — an app-permission entry with no roles has no effect',
        code: 'no_perms',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Validate one role list (read or write), collecting format errors and warnings. */
function validateRoleList(
  roles: string[],
  field: string,
  isWrite: boolean,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  const seen = new Set<string>()
  for (const role of roles) {
    if (!isValidRoleName(role)) {
      errors.push({
        field,
        message: `"${role}" is not a valid Splunk role name (lowercase letters, digits, "_" and "-"; or "*" for all roles)`,
        code: 'invalid_role',
      })
      continue
    }
    if (seen.has(role)) {
      warnings.push({ field, message: `Duplicate role "${role}"`, code: 'duplicate_role' })
    }
    seen.add(role)
    if (isWrite && BROAD_WRITE_ROLES.has(role)) {
      warnings.push({
        field,
        message:
          role === ALL_ROLES
            ? 'Granting write to "*" gives every role edit access to this app — scope to specific roles if possible'
            : `Granting write to the broad role "${role}" lets a large group edit this app — confirm this is intentional`,
        code: 'broad_write',
      })
    }
  }
}
