import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable agent-groups API constraints -------------------------------------

/** Agent group names are capped defensively (Tenable console limit). */
export const MAX_AGENT_GROUP_NAME_LENGTH = 255

/** A cloud scanner id is a positive integer (usually 1). */
export const SCANNER_ID_PATTERN = /^[1-9][0-9]*$/

/** Default scanner id when the canvas field is left blank. */
export const DEFAULT_SCANNER_ID = '1'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface AgentGroupSpec {
  sectionName: string
  /** Group name — the logical identity within its scanner. */
  name: string
  /** Cloud scanner id this group is scoped to (string, e.g. "1"). */
  scannerId: string
}

/** Shape of an agent group returned by GET /scanners/{scanner_id}/agent-groups. */
export interface LiveAgentGroup {
  /** Numeric id — the stable rollback key. */
  id?: number
  uuid?: string
  name?: string
}

/**
 * Each canvas section describes one agent group. A blank scannerId defaults to
 * the cloud scanner ("1"), matching the canvas field default and helpText.
 */
export function extractAgentGroupSpecs(canvas: CanvasSnapshot): AgentGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const scannerRaw =
      typeof fields.scannerId === 'string' && fields.scannerId.trim()
        ? fields.scannerId.trim()
        : DEFAULT_SCANNER_ID

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      scannerId: scannerRaw,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate agent group configurations against Tenable agent-groups API
 * constraints: a name is required and capped at 255 chars, the scanner id must
 * be a positive integer, and the (scannerId, name) pair — a group's logical
 * identity — must be unique. Static rules only; no network calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAgentGroupSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Agent group name is required', code: 'required' })
    } else if (spec.name.length > MAX_AGENT_GROUP_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Agent group name must be ${MAX_AGENT_GROUP_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // scannerId — a positive integer id (blank defaults to "1" upstream)
    if (!SCANNER_ID_PATTERN.test(spec.scannerId)) {
      errors.push({
        field: `${prefix}.scannerId`,
        message: 'Scanner id must be a positive integer (usually 1)',
        code: 'invalid_scanner_id',
      })
    }

    // (scannerId, name) pair is the group's logical identity — dedupe on it.
    // The same name under a different scanner is a DIFFERENT group, so both
    // halves form the key. A JSON-array key keeps the two parts unambiguous.
    if (spec.name) {
      const key = JSON.stringify([spec.scannerId, spec.name])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate agent group "${spec.name}" on scanner ${spec.scannerId} — each group may only be declared once per scanner per canvas`,
          code: 'duplicate_group',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
