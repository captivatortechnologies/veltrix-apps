import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud report constraints -----------------------------------------
// Bounded scope: manages the report DEFINITION/schedule (name + reportType +
// cloudType + a validated target JSON blob), never the generated artifact.

export const MAX_NAME_LENGTH = 255

/** Common built-in report types (advisory only — compliance standard names are also valid). */
export const KNOWN_REPORT_TYPES = ['RIS', 'INVENTORY_OVERVIEW', 'INVENTORY_DETAIL']
export const CLOUD_TYPES = ['aws', 'azure', 'gcp', 'alibaba_cloud', 'oci', 'all']

export interface ReportSpec {
  itemId?: string
  /** name — the identity (Prisma matches reports by name). */
  name: string
  reportType: string
  cloudType: string
  /** target — a JSON object (accountGroups, timeRange, schedule, notifyTo, complianceStandardId, ...). */
  target: Record<string, unknown> | null
  targetError?: string
}

/** A report as returned by GET /report. */
export interface LiveReport {
  id?: string
  reportId?: string
  name?: string
  reportType?: string
  cloudType?: string
  target?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTarget(v: unknown): { target: Record<string, unknown> | null; targetError?: string } {
  if (isObject(v)) return { target: v }
  if (v === null || v === undefined) return { target: null }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { target: null }
    try {
      const parsed = JSON.parse(t)
      if (isObject(parsed)) return { target: parsed }
      return { target: null, targetError: 'Target must be a JSON object' }
    } catch {
      return { target: null, targetError: 'Target must be valid JSON' }
    }
  }
  return { target: null, targetError: 'Target must be a JSON object' }
}

export function extractReportSpecs(canvas: CanvasSnapshot): ReportSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { target, targetError } = parseTarget(f.target)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      reportType: asString(f.reportType),
      cloudType: asString(f.cloudType),
      target,
      targetError,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractReportSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate report "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.reportType) {
      errors.push({ field: `${prefix}.reportType`, message: 'Report type is required', code: 'required' })
    }

    if (spec.cloudType && !CLOUD_TYPES.includes(spec.cloudType)) {
      errors.push({ field: `${prefix}.cloudType`, message: `Cloud type must be one of: ${CLOUD_TYPES.join(', ')}`, code: 'invalid_cloud_type' })
    }

    if (spec.targetError) {
      errors.push({ field: `${prefix}.target`, message: spec.targetError, code: 'invalid_target' })
    } else if (!spec.target) {
      errors.push({ field: `${prefix}.target`, message: 'A target is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
