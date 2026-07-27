import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud notification template constraints --------------------------
// Bounded scope: name + integrationType + integrationId + a validated
// templateConfig JSON blob. jira / service_now templates reference an Integration.

export const MAX_NAME_LENGTH = 255

export const INTEGRATION_TYPES = ['email', 'jira', 'service_now']
/** Integration types that require an integrationId. */
export const INTEGRATION_ID_REQUIRED = ['jira', 'service_now']

export interface NotificationTemplateSpec {
  itemId?: string
  /** name — the identity (Prisma matches notification templates by name). */
  name: string
  integrationType: string
  integrationId: string
  enabled: boolean
  /** templateConfig — a JSON object of per-state field descriptors. */
  templateConfig: Record<string, unknown> | null
  templateConfigError?: string
}

/** A notification template as returned by GET /api/v1/tenant/notification-templates. */
export interface LiveNotificationTemplate {
  id?: string
  name?: string
  integrationType?: string
  integrationId?: string
  enabled?: boolean
  templateConfig?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTemplateConfig(v: unknown): { templateConfig: Record<string, unknown> | null; templateConfigError?: string } {
  if (isObject(v)) return { templateConfig: v }
  if (v === null || v === undefined) return { templateConfig: null }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { templateConfig: null }
    try {
      const parsed = JSON.parse(t)
      if (isObject(parsed)) return { templateConfig: parsed }
      return { templateConfig: null, templateConfigError: 'Template config must be a JSON object' }
    } catch {
      return { templateConfig: null, templateConfigError: 'Template config must be valid JSON' }
    }
  }
  return { templateConfig: null, templateConfigError: 'Template config must be a JSON object' }
}

export function extractNotificationTemplateSpecs(canvas: CanvasSnapshot): NotificationTemplateSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { templateConfig, templateConfigError } = parseTemplateConfig(f.templateConfig)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      integrationType: asString(f.integrationType),
      integrationId: asString(f.integrationId),
      enabled: f.enabled === undefined ? true : asBool(f.enabled),
      templateConfig,
      templateConfigError,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNotificationTemplateSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate notification template "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.integrationType) {
      errors.push({ field: `${prefix}.integrationType`, message: 'Integration type is required', code: 'required' })
    } else if (!INTEGRATION_TYPES.includes(spec.integrationType)) {
      errors.push({ field: `${prefix}.integrationType`, message: `Integration type must be one of: ${INTEGRATION_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (INTEGRATION_ID_REQUIRED.includes(spec.integrationType) && !spec.integrationId) {
      errors.push({ field: `${prefix}.integrationId`, message: `Integration type "${spec.integrationType}" requires an integrationId`, code: 'required' })
    }

    if (spec.templateConfigError) {
      errors.push({ field: `${prefix}.templateConfig`, message: spec.templateConfigError, code: 'invalid_template_config' })
    } else if (!spec.templateConfig) {
      errors.push({ field: `${prefix}.templateConfig`, message: 'A template config is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
