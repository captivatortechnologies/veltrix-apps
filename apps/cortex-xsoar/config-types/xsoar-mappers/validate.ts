import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readBool, readOptionalString, readString } from '../../lib/fields'
import { parseConfigBlob, type MapperDirection } from '../lib/xsoarClassification'

const DIRECTIONS: readonly MapperDirection[] = ['incoming', 'outgoing']

export interface MapperSpec {
  sectionName: string
  /** The mapper's identity in XSOAR — also the required `classifierId` on every save. */
  id: string
  name: string
  direction: MapperDirection
  description?: string
  defaultIncidentType?: string
  definitionId?: string
  feed: boolean
  /** Raw JSON text for the mapping graph, sent as the mapper's "mapping" property. */
  mapperConfig: string
}

/** Each canvas item describes one XSOAR mapper. */
export function extractMapperSpecs(canvas: CanvasSnapshot): MapperSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawDirection = readString(fields.direction) as MapperDirection
    return {
      sectionName: section.name,
      id: readString(fields.id),
      name: readString(fields.name),
      direction: DIRECTIONS.includes(rawDirection) ? rawDirection : 'incoming',
      description: readOptionalString(fields.description),
      defaultIncidentType: readOptionalString(fields.defaultIncidentType),
      definitionId: readOptionalString(fields.definitionId),
      feed: readBool(fields.feed, false),
      mapperConfig: typeof fields.mapperConfig === 'string' ? fields.mapperConfig : '',
    }
  })
}

/**
 * Validate mapper configurations: an id, name and direction are required and
 * the id must be unique (the mapper's identity), and the field-mapping JSON
 * blob, when set, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMapperSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Mapper ID is required', code: 'required' })
      continue
    }
    if (seen.has(spec.id)) {
      errors.push({
        field: `${prefix}.id`,
        message: `Duplicate mapper "${spec.id}" — each mapper id may only be declared once`,
        code: 'duplicate_mapper',
      })
    }
    seen.add(spec.id)

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }

    if (!DIRECTIONS.includes(spec.direction)) {
      errors.push({
        field: `${prefix}.direction`,
        message: `Direction must be one of ${DIRECTIONS.join(', ')}`,
        code: 'invalid_direction',
      })
    }

    const blob = parseConfigBlob(spec.mapperConfig)
    if (blob.error) {
      errors.push({
        field: `${prefix}.mapperConfig`,
        message: `Mapper "${spec.id}" field mapping ${blob.error}`,
        code: 'invalid_config_json',
      })
    } else if (Object.keys(blob.value).length === 0 && !spec.mapperConfig.trim()) {
      warnings.push({
        field: `${prefix}.mapperConfig`,
        message: `Mapper "${spec.id}" declares no field mapping — no fields will be mapped`,
        code: 'empty_config',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
