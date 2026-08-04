import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readBool, readOptionalString, readString } from '../../lib/fields'
import { parseConfigBlob } from '../lib/xsoarClassification'

export interface ClassifierSpec {
  sectionName: string
  /** The classifier's identity in XSOAR — also the required `classifierId` on every save. */
  id: string
  name: string
  description?: string
  defaultIncidentType?: string
  feed: boolean
  /** Raw JSON text for keyTypeMap + transformer, merged onto the saved body. */
  configJson: string
}

/** Each canvas item describes one XSOAR classifier. */
export function extractClassifierSpecs(canvas: CanvasSnapshot): ClassifierSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      id: readString(fields.id),
      name: readString(fields.name),
      description: readOptionalString(fields.description),
      defaultIncidentType: readOptionalString(fields.defaultIncidentType),
      feed: readBool(fields.feed, false),
      configJson: typeof fields.classifierConfig === 'string' ? fields.classifierConfig : '',
    }
  })
}

/**
 * Validate classifier configurations: an id and name are required and the id
 * must be unique (the classifier's identity), and the classification-rules
 * JSON blob, when set, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractClassifierSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Classifier ID is required', code: 'required' })
      continue
    }
    if (seen.has(spec.id)) {
      errors.push({
        field: `${prefix}.id`,
        message: `Duplicate classifier "${spec.id}" — each classifier id may only be declared once`,
        code: 'duplicate_classifier',
      })
    }
    seen.add(spec.id)

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }

    const blob = parseConfigBlob(spec.configJson)
    if (blob.error) {
      errors.push({
        field: `${prefix}.classifierConfig`,
        message: `Classifier "${spec.id}" classification rules ${blob.error}`,
        code: 'invalid_config_json',
      })
    } else if (Object.keys(blob.value).length === 0 && !spec.configJson.trim()) {
      warnings.push({
        field: `${prefix}.classifierConfig`,
        message: `Classifier "${spec.id}" declares no classification rules — every incident will fall to its default incident type`,
        code: 'empty_config',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
