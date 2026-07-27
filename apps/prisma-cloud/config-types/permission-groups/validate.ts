import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud permission group constraints -------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

/** Only Custom groups are user-manageable; Default/Internal are built-in. */
export const PERMISSION_GROUP_TYPES = ['Custom', 'Default', 'Internal']

/** A single feature grant within a permission group. */
export interface PermissionFeature {
  featureName: string
  operations: { create?: boolean; read?: boolean; update?: boolean; delete?: boolean }
}

export interface PermissionGroupSpec {
  itemId?: string
  /** name — the identity (Prisma matches permission groups by name). */
  name: string
  description: string
  permissionGroupType: string
  acceptAccountGroups: boolean
  acceptResourceLists: boolean
  acceptCodeRepositories: boolean
  /** feature grants — an array of { featureName, operations }. */
  features: PermissionFeature[]
  /** set when the raw features value could not be parsed as a JSON array. */
  featuresError?: string
}

/** A permission group as returned by GET /authz/v1/permission_group. */
export interface LivePermissionGroup {
  id?: string
  name?: string
  description?: string | null
  permissionGroupType?: string
  acceptAccountGroups?: boolean
  acceptResourceLists?: boolean
  acceptCodeRepositories?: boolean
  custom?: boolean
  features?: PermissionFeature[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function parseFeatures(v: unknown): { features: PermissionFeature[]; featuresError?: string } {
  if (Array.isArray(v)) return { features: v as PermissionFeature[] }
  if (v === null || v === undefined) return { features: [] }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { features: [] }
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed)) return { features: parsed as PermissionFeature[] }
      return { features: [], featuresError: 'Features must be a JSON array' }
    } catch {
      return { features: [], featuresError: 'Features must be valid JSON' }
    }
  }
  return { features: [], featuresError: 'Features must be a JSON array' }
}

export function extractPermissionGroupSpecs(canvas: CanvasSnapshot): PermissionGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { features, featuresError } = parseFeatures(f.features)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      permissionGroupType: asString(f.permissionGroupType) || 'Custom',
      acceptAccountGroups: asBool(f.acceptAccountGroups),
      acceptResourceLists: asBool(f.acceptResourceLists),
      acceptCodeRepositories: asBool(f.acceptCodeRepositories),
      features,
      featuresError,
    }
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPermissionGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate permission group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!PERMISSION_GROUP_TYPES.includes(spec.permissionGroupType)) {
      errors.push({ field: `${prefix}.permissionGroupType`, message: `Permission group type must be one of: ${PERMISSION_GROUP_TYPES.join(', ')}`, code: 'invalid_type' })
    } else if (spec.permissionGroupType !== 'Custom') {
      errors.push({ field: `${prefix}.permissionGroupType`, message: 'Only Custom permission groups can be managed as code; Default and Internal groups are built-in', code: 'protected_type' })
    }

    if (spec.featuresError) {
      errors.push({ field: `${prefix}.features`, message: spec.featuresError, code: 'invalid_features' })
    } else if (spec.features.length === 0) {
      errors.push({ field: `${prefix}.features`, message: 'At least one feature grant is required', code: 'required' })
    } else {
      const bad = spec.features.some((ft) => !isObject(ft) || typeof ft.featureName !== 'string' || !ft.featureName.trim() || !isObject(ft.operations))
      if (bad) {
        errors.push({ field: `${prefix}.features`, message: 'Each feature must be an object with a non-empty "featureName" and an "operations" object', code: 'invalid_features' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
