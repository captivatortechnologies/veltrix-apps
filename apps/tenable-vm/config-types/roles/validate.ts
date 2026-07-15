import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Access-Control Roles API constraints ----------------------------

/** Role names in Tenable are bounded; keep this generous but non-empty. */
export const MAX_ROLE_NAME_LENGTH = 255

/**
 * A role_permission_strings token is a PascalCase identifier (e.g. "CanScan",
 * "CanView"). No commas/whitespace — those separate tokens, never appear inside
 * one. We validate the SHAPE only; the full catalog of permission strings is
 * defined by Tenable's access-control API and shown in the console role editor,
 * so we do NOT enum-check against a hardcoded list we cannot cite.
 */
export const PERMISSION_STRING_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Built-in Tenable roles are type SYSTEM and read-only — the deploy handler
 * refuses to mutate one at runtime (it checks the live role's `type`). Statically
 * we can only warn on the well-known reserved names so a user is steered away
 * before the deploy fails. Matched case-insensitively.
 */
export const RESERVED_ROLE_NAMES = [
  'Administrator',
  'Scan Manager',
  'Standard',
  'Scan Operator',
  'Basic',
  'Vulnerability Manager',
  'Vulnerability Analyst',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RoleSpec {
  sectionName: string
  /** Role name — the logical identity; matched to a live role's uuid on deploy. */
  name: string
  description?: string
  /** role_permission_strings — the permissions granted by this role. */
  permissionStrings: string[]
}

/** Shape of a role returned by GET /access-control/v1/roles. */
export interface LiveRole {
  uuid?: string
  name?: string
  /** "CUSTOM" (editable) or "SYSTEM" (built-in, read-only). */
  type?: string
  description?: string
  /** Some tenants echo permissions back under either key. */
  role_permission_strings?: string[]
  permissions?: string[]
}

/**
 * Normalize a permissionStrings value (tags array OR comma/newline string) to a
 * de-duplicated list of tokens. Case is PRESERVED — permission strings are
 * case-sensitive PascalCase identifiers, so "CanScan" and "canscan" are not the
 * same permission. Order is preserved on first occurrence.
 */
export function normalizePermissionStrings(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of parts) {
    const token = part.trim()
    if (token && !seen.has(token)) {
      seen.add(token)
      result.push(token)
    }
  }
  return result
}

/** Read the live permission strings regardless of which key the tenant uses. */
export function livePermissionStrings(role: LiveRole): string[] {
  const raw = role.role_permission_strings ?? role.permissions ?? []
  return Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : []
}

/** True when a live role is a built-in SYSTEM role (read-only). */
export function isSystemRole(role: LiveRole): boolean {
  return (role.type ?? '').trim().toUpperCase() === 'SYSTEM'
}

/** Each canvas item describes one Tenable access-control role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      permissionStrings: normalizePermissionStrings(fields.permissionStrings),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate role configurations against Access-Control Roles API constraints:
 * a name is required (unique within the canvas, length-bounded), at least one
 * permission string is required, and every permission string must be a bare
 * PascalCase token. Static only — no network. The SYSTEM-role guard is a
 * runtime check in deploy (it needs the live role's type), but we warn here on
 * reserved built-in names so the user is steered away early.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, length-bounded, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_ROLE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }

      // Role name is the logical identity — dedupe on it. Names are unique in
      // Tenable (a duplicate name is a 409), so match case-insensitively.
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role "${spec.name}" — each role may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)

      // Reserved built-in name — warn (not an error). Deploy will refuse to
      // modify the matching SYSTEM role, and a CREATE with this name would 409.
      if (RESERVED_ROLE_NAMES.some((r) => r.toLowerCase() === key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a built-in Tenable role (type SYSTEM) and is read-only — a deploy will refuse to modify it. Choose a distinct custom role name.`,
          code: 'reserved_role_name',
        })
      }
    }

    // permissionStrings — at least one is required; a role with no permissions
    // grants nothing and Tenable expects role_permission_strings on create.
    if (spec.permissionStrings.length === 0) {
      errors.push({
        field: `${prefix}.permissionStrings`,
        message: 'At least one permission string is required (e.g. CanScan, CanView)',
        code: 'required',
      })
    } else {
      const invalid = spec.permissionStrings.filter((p) => !PERMISSION_STRING_PATTERN.test(p))
      if (invalid.length > 0) {
        errors.push({
          field: `${prefix}.permissionStrings`,
          message: `Invalid permission string(s) "${invalid.join(', ')}" — each must be a single token like CanScan or CanView (letters, digits and underscores; no spaces)`,
          code: 'invalid_permission',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
