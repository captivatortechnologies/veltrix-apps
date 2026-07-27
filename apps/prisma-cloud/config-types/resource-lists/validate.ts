import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud resource list constraints ----------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export const RESOURCE_LIST_TYPES = ['TAG', 'RESOURCE_GROUP', 'COMPUTE_ACCESS_GROUP']

export interface ResourceListSpec {
  itemId?: string
  /** name — the identity (Prisma matches resource lists by name). */
  name: string
  description: string
  resourceListType: string
  /** members — a JSON array whose element shape depends on resourceListType. */
  members: unknown[]
  /** set when the raw members value could not be parsed as a JSON array. */
  membersError?: string
}

/** A resource list as returned by GET /v1/resource_list. */
export interface LiveResourceList {
  id?: string
  name?: string
  description?: string | null
  resourceListType?: string
  members?: unknown[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseMembers(v: unknown): { members: unknown[]; membersError?: string } {
  if (Array.isArray(v)) return { members: v }
  if (v === null || v === undefined) return { members: [] }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { members: [] }
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed)) return { members: parsed }
      return { members: [], membersError: 'Members must be a JSON array' }
    } catch {
      return { members: [], membersError: 'Members must be valid JSON' }
    }
  }
  return { members: [], membersError: 'Members must be a JSON array' }
}

export function extractResourceListSpecs(canvas: CanvasSnapshot): ResourceListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { members, membersError } = parseMembers(f.members)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      resourceListType: asString(f.resourceListType),
      members,
      membersError,
    }
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractResourceListSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate resource list "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.resourceListType) {
      errors.push({ field: `${prefix}.resourceListType`, message: 'Resource list type is required', code: 'required' })
    } else if (!RESOURCE_LIST_TYPES.includes(spec.resourceListType)) {
      errors.push({ field: `${prefix}.resourceListType`, message: `Resource list type must be one of: ${RESOURCE_LIST_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.membersError) {
      errors.push({ field: `${prefix}.members`, message: spec.membersError, code: 'invalid_members' })
    } else {
      if (spec.members.length === 0) {
        warnings.push({ field: `${prefix}.members`, message: 'This resource list has no members', code: 'empty_members' })
      }
      if (spec.resourceListType === 'TAG') {
        const bad = spec.members.some((m) => !isObject(m) || typeof m.key !== 'string' || !(m.key as string).trim())
        if (bad) errors.push({ field: `${prefix}.members`, message: 'TAG members must be objects each with a non-empty "key"', code: 'invalid_members' })
      } else if (spec.resourceListType === 'RESOURCE_GROUP') {
        const bad = spec.members.some((m) => typeof m !== 'string' || !m.trim())
        if (bad) errors.push({ field: `${prefix}.members`, message: 'RESOURCE_GROUP members must be non-empty resource group id strings', code: 'invalid_members' })
      } else if (spec.resourceListType === 'COMPUTE_ACCESS_GROUP') {
        const bad = spec.members.some((m) => !isObject(m))
        if (bad) errors.push({ field: `${prefix}.members`, message: 'COMPUTE_ACCESS_GROUP members must be objects', code: 'invalid_members' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
