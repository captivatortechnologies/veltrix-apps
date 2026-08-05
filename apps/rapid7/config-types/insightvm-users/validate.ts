import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** A light sanity check — not a full RFC 5322 validator. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface UserSpec {
  sectionName: string
  login: string
  name: string
  email: string
  enabled: boolean
  /** ⚠ Write-only secret. Sent on every create AND update; never read/diffed/stored. */
  password: string
  passwordResetOnLogin: boolean
  roleId: string
  allSites: boolean
  allAssetGroups: boolean
  superuser: boolean
  /** Site names granted explicit access, one per line — ignored when allSites is true. */
  siteNames: string[]
  /** Asset group names granted explicit access, one per line — ignored when allAssetGroups is true. */
  assetGroupNames: string[]
  authSourceType: string
  authSourceId: number | undefined
}

/** Shape of a user returned by GET /users. */
export interface LiveUser {
  id?: number
  login?: string
  name?: string
  email?: string
  enabled?: boolean
  locked?: boolean
  role?: { id?: string; name?: string; allSites?: boolean; allAssetGroups?: boolean; superuser?: boolean }
  authentication?: { id?: number; type?: string }
}

/** The login natural key — a user's logical identity, matched case-insensitively. */
export function userKey(spec: { login: string }): string {
  return spec.login.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Split a newline-delimited textarea into a trimmed, de-blanked list of names. */
export function parseNames(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one InsightVM console user. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      sectionName: section.name,
      login: str(fields.login),
      name: str(fields.name),
      email: str(fields.email),
      enabled: readBool(fields.enabled, true),
      // Password is intentionally NOT trimmed of interior characters, only surrounding whitespace.
      password: typeof fields.password === 'string' ? fields.password.trim() : '',
      passwordResetOnLogin: readBool(fields.password_reset_on_login, false),
      roleId: str(fields.role_id),
      allSites: readBool(fields.all_sites, false),
      allAssetGroups: readBool(fields.all_asset_groups, false),
      superuser: readBool(fields.superuser, false),
      siteNames: parseNames(typeof fields.site_names === 'string' ? fields.site_names : ''),
      assetGroupNames: parseNames(typeof fields.asset_group_names === 'string' ? fields.asset_group_names : ''),
      authSourceType: str(fields.auth_source_type),
      authSourceId: readNumber(fields.auth_source_id),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate console user configurations: login, name, role id and password are
 * required; email (when present) must look like an email address; site/asset
 * group names are meaningless when the corresponding all-access flag is set
 * (flagged as a warning, not an error); and the login (the natural key) is
 * unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.login) errors.push({ field: `${prefix}.login`, message: 'Login is required', code: 'required' })
    if (!spec.name) errors.push({ field: `${prefix}.name`, message: 'Full name is required', code: 'required' })
    if (!spec.roleId) errors.push({ field: `${prefix}.role_id`, message: 'Role id is required', code: 'required' })
    if (!spec.password) {
      // Only the absence of the password is reported — never its value.
      errors.push({ field: `${prefix}.password`, message: 'Password is required', code: 'required' })
    }

    if (spec.email && !EMAIL_PATTERN.test(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" does not look like a valid email address`, code: 'invalid_email' })
    }

    if (spec.allSites && spec.siteNames.length > 0) {
      warnings.push({
        field: `${prefix}.site_names`,
        message: 'Site names are ignored — the role already grants access to all sites',
        code: 'redundant_site_names',
      })
    }
    if (spec.allAssetGroups && spec.assetGroupNames.length > 0) {
      warnings.push({
        field: `${prefix}.asset_group_names`,
        message: 'Asset group names are ignored — the role already grants access to all asset groups',
        code: 'redundant_asset_group_names',
      })
    }

    if (spec.login) {
      const key = userKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.login`,
          message: `Duplicate user "${spec.login}" — each login may only be declared once`,
          code: 'duplicate_user',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
