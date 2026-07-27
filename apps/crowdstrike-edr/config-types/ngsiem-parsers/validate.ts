import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Next-Gen SIEM Parser API constraints ------------------------------------
//
// A parser normalizes raw log events into the CrowdStrike Parsing Standard
// (ECS-aligned). The verified JSON parser endpoint accepts name, repository and
// script; `parsers-repository` is the only repository CrowdStrike documents for
// custom parsers. The parser script itself is a LogScale parser DSL document —
// this app validates only that it is present (it does not parse the DSL).

export const PARSER_REPOSITORY = 'parsers-repository'
export const MAX_PARSER_NAME_LENGTH = 255
export const MAX_DATATYPE_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ParserSpec {
  sectionName: string
  name: string
  repository: string
  /**
   * The data type the parser produces. Captured for the config record and shown
   * in the UI; NOT a field of the verified JSON parser endpoint, so it is not
   * written to Falcon or drift-checked (see deploy.ts).
   */
  datatype?: string
  script: string
  /**
   * Advisory enablement flag. The verified JSON parser endpoint models no
   * enable/disable state, so this is tracked but not written or drift-checked.
   */
  enabled: boolean
}

/** Shape of a parser returned by GET /ngsiem-content/entities/parsers/v1. */
export interface LiveParser {
  id?: string
  name?: string
  repository?: string
  script?: string
  /** Last modifier — read best-effort for drift attribution (field names unverified for NG-SIEM). */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  [key: string]: unknown
}

/** Each canvas section describes one Falcon Next-Gen SIEM parser. */
export function extractParserSpecs(canvas: CanvasSnapshot): ParserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const repository =
      typeof fields.repository === 'string' && fields.repository.trim()
        ? fields.repository.trim()
        : PARSER_REPOSITORY

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      repository,
      datatype:
        typeof fields.datatype === 'string' && fields.datatype.trim()
          ? fields.datatype.trim()
          : undefined,
      // Preserve the script verbatim (whitespace is significant in the parser DSL).
      script: typeof fields.script === 'string' ? fields.script : '',
      enabled: coerceBoolean(fields.enabled, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Next-Gen SIEM parser configurations: a required unique name, a
 * non-empty parser script, and a repository. The parser DSL is NOT parsed —
 * only its presence is checked, following the CrowdStrike Parsing Standard.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({
      field: 'sections',
      message: 'Canvas has no configuration sections',
      code: 'empty_canvas',
    })
    return { valid: false, errors, warnings }
  }

  const specs = extractParserSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, bounded, unique per canvas, immutable after creation
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Parser name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_PARSER_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Parser name must be ${MAX_PARSER_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate parser "${spec.name}" — each parser may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // script — must be present; the DSL body itself is not parsed here
    if (!spec.script || !spec.script.trim()) {
      errors.push({
        field: `${prefix}.script`,
        message: 'Parser script is required (a LogScale/CrowdStrike Parsing Standard parser document)',
        code: 'empty_script',
      })
    }

    // repository — defaulted, but flag anything other than the documented value
    if (!spec.repository) {
      errors.push({
        field: `${prefix}.repository`,
        message: 'Repository is required',
        code: 'required',
      })
    } else if (spec.repository !== PARSER_REPOSITORY) {
      warnings.push({
        field: `${prefix}.repository`,
        message: `The only repository CrowdStrike documents for custom parsers is "${PARSER_REPOSITORY}"`,
        code: 'nonstandard_repository',
      })
    }

    // datatype — optional, bounded
    if (spec.datatype && spec.datatype.length > MAX_DATATYPE_LENGTH) {
      errors.push({
        field: `${prefix}.datatype`,
        message: `Data type must be ${MAX_DATATYPE_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
