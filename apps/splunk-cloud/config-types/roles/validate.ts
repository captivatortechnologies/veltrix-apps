import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Cloud roles — validation + the spec extraction shared by
// deploy / rollback / healthCheck / driftDetect.
//
// Roles are the one object in this app that ACS cannot manage (ACS covers
// indexes, HEC, IP allow lists, ports, limits, maintenance windows, apps and
// tokens — identity is out of scope), and authorize.conf is on Splunk Cloud's
// AppInspect deny list, so they cannot ship inside a private app either. They
// therefore go to the same REST endpoint Splunk Enterprise uses,
// /services/authorization/roles, on the stack's management port 8089.
// See lib/splunkRest.ts.
// =============================================================================

/** Splunk role names are lowercase; no spaces, colons or slashes. */
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
export const MAX_ROLE_NAME_LENGTH = 100

/** Capabilities are lowercase identifiers, e.g. `schedule_search`, `rest_properties_get`. */
export const CAPABILITY_RE = /^[a-z0-9_]+$/

/** Index names in srchIndexesAllowed/Default may use wildcards (`*`, `web-*`). */
export const SEARCH_INDEX_RE = /^[a-zA-Z0-9_*-]+$/

/** App ids (defaultApp). */
export const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/**
 * Roles Splunk Cloud owns. sc_admin is the Cloud administrator role and
 * splunk-system-role is internal — redefining either through the REST API is
 * rejected by the stack (or breaks administration), so it is an error here.
 */
export const CLOUD_RESERVED_ROLES = new Set(['sc_admin', 'splunk-system-role'])

/** Splunk's built-in roles: editable, but a change reaches every user who holds them. */
export const BUILT_IN_ROLES = new Set(['admin', 'power', 'user', 'can_delete', 'splunk-system-user'])

/** Numeric role fields that map 1:1 to REST parameters of the same name. */
export const ROLE_QUOTA_FIELDS = [
  'srchJobsQuota',
  'rtSrchJobsQuota',
  'srchDiskQuota',
  'cumulativeSrchJobsQuota',
  'cumulativeRTSrchJobsQuota',
] as const
export type RoleQuotaField = (typeof ROLE_QUOTA_FIELDS)[number]

export interface RoleSpec {
  sectionName: string
  name: string
  importedRoles?: string[]
  capabilities?: string[]
  srchIndexesAllowed?: string[]
  srchIndexesDefault?: string[]
  srchFilter?: string
  srchTimeWin?: number
  defaultApp?: string
  quotas: Partial<Record<RoleQuotaField, number>>
}

/**
 * Shape of a role as returned by
 * GET /services/authorization/roles/{name} → entry[0].content.
 * Splunk returns the list fields as arrays and the quotas as numbers.
 */
export interface LiveRole {
  imported_roles?: string[]
  capabilities?: string[]
  srchIndexesAllowed?: string[]
  srchIndexesDefault?: string[]
  srchFilter?: string
  srchTimeWin?: number | string
  defaultApp?: string
  srchJobsQuota?: number | string
  rtSrchJobsQuota?: number | string
  srchDiskQuota?: number | string
  cumulativeSrchJobsQuota?: number | string
  cumulativeRTSrchJobsQuota?: number | string
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/** Canvas list fields arrive as arrays (tags) or comma/newline text. */
export function toList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return undefined
}

/** Normalize a live REST list value (array, or comma-separated string). */
export function normalizeLiveList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** True when `index` is covered by an allow-list entry (supports `*` wildcards). */
export function indexAllowedBy(allowed: string[], index: string): boolean {
  return allowed.some((pattern) => {
    if (!pattern.includes('*')) return pattern === index
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
    return re.test(index)
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** Each canvas section describes one Splunk Cloud role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const quotas: Partial<Record<RoleQuotaField, number>> = {}
    for (const key of ROLE_QUOTA_FIELDS) {
      const value = toNumber(fields[key])
      if (value !== undefined) quotas[key] = value
    }
    const srchFilter =
      typeof fields.srchFilter === 'string' && fields.srchFilter.trim()
        ? fields.srchFilter.trim()
        : undefined
    const defaultApp =
      typeof fields.defaultApp === 'string' && fields.defaultApp.trim()
        ? fields.defaultApp.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      importedRoles: toList(fields.importedRoles),
      capabilities: toList(fields.capabilities),
      srchIndexesAllowed: toList(fields.srchIndexesAllowed),
      srchIndexesDefault: toList(fields.srchIndexesDefault),
      srchFilter,
      srchTimeWin: toNumber(fields.srchTimeWin),
      defaultApp,
      quotas,
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate Splunk Cloud role configurations against Splunk's role model:
 * naming rules, reserved Cloud roles, capability/index/app name formats,
 * default-searched-indexes coverage, search time window and quotas.
 *
 * Never touches the network — the REST prerequisites (port 8089 open; caller IP
 * on the `search-api` allow list) are surfaced at deploy/health-check time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no role definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  const seenNames = new Set<string>()

  for (const spec of extractRoleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    // --- Role name ------------------------------------------------------------
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else {
      if (!ROLE_NAME_RE.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'Role name must begin with a lowercase letter or number and contain only lowercase letters, numbers, underscores and hyphens (Splunk rejects uppercase, spaces, colons and slashes)',
          code: 'invalid_format',
        })
      }
      if (spec.name.length > MAX_ROLE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (CLOUD_RESERVED_ROLES.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is reserved by Splunk Cloud and cannot be managed as code — inherit from it instead (Inherited Roles)`,
          code: 'reserved_role',
        })
      } else if (BUILT_IN_ROLES.has(spec.name)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a built-in Splunk role — changes here apply to every user who holds it. Prefer a new role that inherits from it.`,
          code: 'built_in_role',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role "${spec.name}" — each role may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(spec.name)
    }

    // --- Inherited roles ------------------------------------------------------
    if (spec.importedRoles) {
      for (const role of spec.importedRoles) {
        if (!ROLE_NAME_RE.test(role)) {
          errors.push({
            field: `${prefix}.importedRoles`,
            message: `"${role}" is not a valid Splunk role name`,
            code: 'invalid_format',
          })
        }
      }
      if (spec.name && spec.importedRoles.includes(spec.name)) {
        errors.push({
          field: `${prefix}.importedRoles`,
          message: `Role "${spec.name}" cannot inherit from itself`,
          code: 'self_import',
        })
      }
    }

    // --- Capabilities ---------------------------------------------------------
    if (spec.capabilities) {
      for (const capability of spec.capabilities) {
        if (!CAPABILITY_RE.test(capability)) {
          errors.push({
            field: `${prefix}.capabilities`,
            message: `"${capability}" is not a valid Splunk capability name (lowercase letters, digits and underscores)`,
            code: 'invalid_format',
          })
        }
      }
    }

    // A role that grants nothing and inherits nothing is almost certainly a mistake.
    const hasCapabilities = (spec.capabilities?.length ?? 0) > 0
    const hasImports = (spec.importedRoles?.length ?? 0) > 0
    if (!hasCapabilities && !hasImports) {
      warnings.push({
        field: `${prefix}.capabilities`,
        message:
          'Role grants no capabilities and inherits no roles — users holding it will not be able to do anything (not even search)',
        code: 'no_privileges',
      })
    }

    // --- Searchable indexes ---------------------------------------------------
    if (spec.srchIndexesAllowed) {
      for (const index of spec.srchIndexesAllowed) {
        if (!SEARCH_INDEX_RE.test(index)) {
          errors.push({
            field: `${prefix}.srchIndexesAllowed`,
            message: `"${index}" is not a valid Splunk index name or wildcard pattern`,
            code: 'invalid_format',
          })
        }
      }
      if (spec.srchIndexesAllowed.includes('*')) {
        warnings.push({
          field: `${prefix}.srchIndexesAllowed`,
          message:
            'Role can search every index on the stack — list the indexes it actually needs for least privilege',
          code: 'unrestricted_indexes',
        })
      }
    }

    if (spec.srchIndexesDefault) {
      for (const index of spec.srchIndexesDefault) {
        if (!SEARCH_INDEX_RE.test(index)) {
          errors.push({
            field: `${prefix}.srchIndexesDefault`,
            message: `"${index}" is not a valid Splunk index name or wildcard pattern`,
            code: 'invalid_format',
          })
          continue
        }
        // A default index outside the allow-list makes every un-qualified search
        // silently return nothing.
        if (
          spec.srchIndexesAllowed &&
          spec.srchIndexesAllowed.length > 0 &&
          !indexAllowedBy(spec.srchIndexesAllowed, index)
        ) {
          errors.push({
            field: `${prefix}.srchIndexesDefault`,
            message: `Default searched index "${index}" is not covered by Searchable Indexes — searches that name no index would return nothing`,
            code: 'index_not_allowed',
          })
        }
      }
    }

    // --- Search filter / time window -----------------------------------------
    if (spec.srchTimeWin !== undefined) {
      if (!isInt(spec.srchTimeWin) || spec.srchTimeWin < -1) {
        errors.push({
          field: `${prefix}.srchTimeWin`,
          message: 'Search time window must be an integer number of seconds (-1 = unlimited)',
          code: 'invalid_value',
        })
      }
    }

    // --- Default app ----------------------------------------------------------
    if (spec.defaultApp !== undefined && !APP_NAME_RE.test(spec.defaultApp)) {
      errors.push({
        field: `${prefix}.defaultApp`,
        message: 'Default app must be a valid Splunk app id (letters, digits, underscores, dots, hyphens)',
        code: 'invalid_format',
      })
    }

    // --- Quotas ---------------------------------------------------------------
    for (const key of ROLE_QUOTA_FIELDS) {
      const value = spec.quotas[key]
      if (value === undefined) continue
      if (!isInt(value) || value < 0) {
        errors.push({
          field: `${prefix}.${key}`,
          message: `${key} must be a non-negative integer`,
          code: 'invalid_value',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
