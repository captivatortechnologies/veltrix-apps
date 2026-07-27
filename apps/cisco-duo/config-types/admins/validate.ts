import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo administrator constraints -------------------------------------

export const MAX_NAME_LENGTH = 100

/** The administrator roles the Duo Admin API accepts, exact-case. */
export const ADMIN_ROLES = [
  'Owner',
  'Administrator',
  'Application Manager',
  'User Manager',
  'Help Desk',
  'Billing',
  'Phishing Manager',
  'Read-only',
] as const

export interface AdminSpec {
  itemId?: string
  /** email — the administrator's login and natural identity. */
  email: string
  name: string
  role: string
}

/** An administrator as returned by GET /admin/v1/admins. */
export interface LiveAdmin {
  admin_id?: string
  email?: string
  name?: string
  role?: string
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Loose RFC-5322-ish email shape — Duo does the authoritative validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function extractAdminSpecs(canvas: CanvasSnapshot): AdminSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      email: asString(f.email).toLowerCase(),
      name: asString(f.name) || item.name,
      role: asString(f.role) || 'Read-only',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAdminSpecs(ctx.canvas)
  const seenEmails = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required', code: 'required' })
    } else {
      if (!EMAIL_RE.test(spec.email)) {
        errors.push({ field: `${prefix}.email`, message: `"${spec.email}" is not a valid email address`, code: 'invalid_email' })
      }
      if (seenEmails.has(spec.email)) {
        errors.push({ field: `${prefix}.email`, message: `Duplicate administrator "${spec.email}" — each may only be declared once per canvas`, code: 'duplicate_email' })
      }
      seenEmails.add(spec.email)
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!(ADMIN_ROLES as readonly string[]).includes(spec.role)) {
      errors.push({ field: `${prefix}.role`, message: `Role must be one of: ${ADMIN_ROLES.join(', ')}`, code: 'invalid_role' })
    } else if (spec.role === 'Owner') {
      warnings.push({ field: `${prefix}.role`, message: 'The Duo Admin API rejects creating/modifying "Owner" administrators — declare Owners only if they already exist with that role', code: 'owner_role' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
