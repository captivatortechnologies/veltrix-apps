import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readBool, readOptionalString, readString } from '../../lib/fields'

// --- XSOAR incident-type constraints -----------------------------------------

/** A hex color like #FF0000 (XSOAR renders the incident-type badge in this color). */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IncidentTypeSpec {
  sectionName: string
  /** The incident-type name — its logical identity (list + match). */
  name: string
  color?: string
  playbookId?: string
  autorun: boolean
  disabled: boolean
  preProcessingScript?: string
  closureScript?: string
}

/** Shape of an incident type returned by GET /incidenttype. */
export interface LiveIncidentType {
  id?: string
  name?: string
  color?: string
  playbookId?: string
  autorun?: boolean
  disabled?: boolean
  preProcessingScript?: string
  closureScript?: string
  version?: number
  system?: boolean
  locked?: boolean
}

/**
 * True for a built-in / locked incident type XSOAR ships (e.g. "Unclassified").
 * The pipeline refuses to modify or delete these.
 */
export function isProtectedType(type: LiveIncidentType): boolean {
  return type.system === true || type.locked === true
}

/** Each canvas item describes one XSOAR incident type. */
export function extractIncidentTypeSpecs(canvas: CanvasSnapshot): IncidentTypeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      color: readOptionalString(fields.color),
      playbookId: readOptionalString(fields.playbookId),
      autorun: readBool(fields.autorun, false),
      disabled: readBool(fields.disabled, false),
      preProcessingScript: readOptionalString(fields.preProcessingScript),
      closureScript: readOptionalString(fields.closureScript),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate XSOAR incident-type configurations: a name is required and unique,
 * a color (when set) must be a hex value, and enabling auto-run without a default
 * playbook is warned about (nothing would run).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIncidentTypeSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Incident type name is required', code: 'required' })
      continue
    }

    if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate incident type "${spec.name}" — each name may only be declared once`,
        code: 'duplicate_type',
      })
    }
    seen.add(spec.name)

    if (spec.color && !HEX_COLOR_RE.test(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: `Color "${spec.color}" must be a hex value like #29B473`,
        code: 'invalid_color',
      })
    }

    if (spec.autorun && !spec.playbookId) {
      warnings.push({
        field: `${prefix}.autorun`,
        message: `Incident type "${spec.name}" enables auto-run but declares no default playbook — nothing will run`,
        code: 'autorun_without_playbook',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
