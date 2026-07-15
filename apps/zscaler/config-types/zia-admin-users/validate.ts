import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Admin Users constraints ---------------------------------------------

/** ZIA caps an admin login name and display name at 255 characters. */
export const MAX_LOGIN_NAME_LENGTH = 255
export const MAX_USER_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AdminUserSpec {
  sectionName: string
  /** The admin login name — its logical identity (list /adminUsers + match on loginName). */
  loginName: string
  /** Display name shown in the ZIA Admin Portal. */
  userName: string
  /** Email address. */
  email: string
  /** The role NAME; resolved to a role id at deploy time via /adminRoles. */
  roleName: string
  comments?: string
  /** Whether the account is disabled (cannot sign in). */
  disabled: boolean
  /**
   * WRITE-ONLY password. ZIA never returns it on GET, so it can be neither read
   * back nor drift-checked. deploy sends it ONLY on a create (a POST) and NEVER
   * on an update, and it is NEVER captured into rollback data, artifacts or logs.
   * undefined = blank. validate always requires it present (it cannot tell a
   * create from an update, so it demands a value on every deploy).
   */
  password?: string
}

/** A role reference on a live admin user (id + name). */
export interface LiveAdminRole {
  id?: number
  name?: string
}

/**
 * Shape of an admin user returned by GET /adminUsers.
 * Note: `password` is a write-only secret and is NEVER present here.
 */
export interface LiveAdminUser {
  id?: number
  loginName?: string
  userName?: string
  email?: string
  role?: LiveAdminRole
  comments?: string
  disabled?: boolean
}

/** Coerce a boolean canvas field, falling back to a default when unset. */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Each canvas item describes one ZIA admin user. */
export function extractAdminUserSpecs(canvas: CanvasSnapshot): AdminUserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const comments =
      typeof fields.comments === 'string' && fields.comments.trim()
        ? fields.comments.trim()
        : undefined
    // Preserve the exact password characters (a password may contain spaces),
    // but treat a whitespace-only value as blank = missing.
    const rawPassword = typeof fields.password === 'string' ? fields.password : ''
    const password = rawPassword.trim() ? rawPassword : undefined

    return {
      sectionName: section.name,
      loginName: typeof fields.login_name === 'string' ? fields.login_name.trim() : '',
      userName: typeof fields.user_name === 'string' ? fields.user_name.trim() : '',
      email: typeof fields.email === 'string' ? fields.email.trim() : '',
      roleName: typeof fields.role_name === 'string' ? fields.role_name.trim() : '',
      comments,
      disabled: toBool(fields.disabled, false),
      password,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate admin user configurations against ZIA constraints: login name,
 * display name, email and role name are all required; the email must contain an
 * '@'; and the login name — an account's logical identity — must be unique across
 * the canvas (matched case-insensitively).
 *
 * The password is REQUIRED on every deploy. Unlike a normal optional secret,
 * validate demands it here because it is static and cannot tell a create from an
 * update — and a create without a password is rejected by ZIA. deploy then sends
 * the password ONLY on a create; on an update it is discarded (never sent, never
 * stored). See config-types/zia-admin-users/deploy.ts.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAdminUserSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // login_name — required, capped at 255 chars, unique (its logical identity)
    if (!spec.loginName) {
      errors.push({ field: `${prefix}.login_name`, message: 'Login name is required', code: 'required' })
    } else {
      if (spec.loginName.length > MAX_LOGIN_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.login_name`,
          message: `Login name must be ${MAX_LOGIN_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.loginName.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.login_name`,
          message: `Duplicate admin user "${spec.loginName}" — each login name may only be declared once per canvas`,
          code: 'duplicate_admin_user',
        })
      }
      seen.add(key)
    }

    // user_name — required display name
    if (!spec.userName) {
      errors.push({ field: `${prefix}.user_name`, message: 'Display name is required', code: 'required' })
    } else if (spec.userName.length > MAX_USER_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.user_name`,
        message: `Display name must be ${MAX_USER_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // email — required, basic shape check (must contain an '@')
    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required', code: 'required' })
    } else if (!spec.email.includes('@')) {
      errors.push({
        field: `${prefix}.email`,
        message: 'Email must be a valid address containing "@", e.g. admin@example.com',
        code: 'invalid_email',
      })
    }

    // role_name — required; resolved to a role id at deploy time
    if (!spec.roleName) {
      errors.push({ field: `${prefix}.role_name`, message: 'Role name is required', code: 'required' })
    }

    // password — required on every deploy (validate cannot tell create vs update)
    if (!spec.password) {
      errors.push({ field: `${prefix}.password`, message: 'Password is required', code: 'required' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
