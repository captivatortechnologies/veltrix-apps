import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Gateway Allowed Access API constraints ----------------------------
// https://docs.akeyless.io
//   POST /gateway-create-allowed-access, /gateway-update-allowed-access,
//   /gateway-delete-allowed-access, /gateway-get-allowed-access
// Identity is the rule's NAME.

export const PERMISSIONS = [
  'defaults',
  'targets',
  'classic_keys',
  'automatic_migration',
  'ldap_auth',
  'dynamic_secret',
  'k8s_auth',
  'log_forwarding',
  'zero_knowledge_encryption',
  'rotated_secret',
  'caching',
  'event_forwarding',
  'admin',
  'kmip',
  'general',
  'rotate_secret_value',
] as const

export interface AllowedAccessSpec {
  sectionName: string
  name: string
  description: string
  accessId: string
  permissions: string[]
  subClaims: Record<string, string>
  caseSensitive: boolean
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}
function keyValue(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = str(val)
  return out
}

/** Each canvas item describes one Akeyless Gateway allowed-access rule. */
export function extractAllowedAccessSpecs(canvas: CanvasSnapshot): AllowedAccessSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      description: str(f.description),
      accessId: str(f.accessId),
      permissions: toStringList(f.permissions),
      subClaims: keyValue(f.subClaims),
      caseSensitive: f.caseSensitive === undefined ? true : bool(f.caseSensitive),
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAllowedAccessSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate allowed access rule "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.accessId) {
      errors.push({ field: `${prefix}.accessId`, message: 'Auth Method is required', code: 'required' })
    }

    const invalidPerms = spec.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p))
    if (invalidPerms.length > 0) {
      errors.push({
        field: `${prefix}.permissions`,
        message: `Invalid permission(s): ${invalidPerms.join(', ')} (allowed: ${PERMISSIONS.join(', ')})`,
        code: 'invalid_value',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
