import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { parsePipelineTitles } from './_shared'

/**
 * Validate pipeline-connection items: a non-empty stream title (the identity —
 * one item per stream, a duplicate is flagged, last one wins) and a well-formed
 * `pipeline_titles` JSON array (an empty array is valid — it disconnects every
 * pipeline from the stream). Static — no target access, so an unresolvable
 * stream/pipeline title surfaces as a deploy-time error.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one pipeline connection.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const streamTitle = asString(item.fields.stream_title)

    if (!streamTitle) {
      errors.push({ field: `items[${i}].stream_title`, message: 'Stream title is required.', code: 'EMPTY_STREAM_TITLE' })
    } else if (seen.has(streamTitle)) {
      warnings.push({ field: `items[${i}].stream_title`, message: `Stream "${streamTitle}" is listed more than once; the last one wins.`, code: 'DUPLICATE_STREAM' })
    } else {
      seen.add(streamTitle)
    }

    const { titles, error } = parsePipelineTitles(item.fields.pipeline_titles)
    if (error) {
      errors.push({ field: `items[${i}].pipeline_titles`, message: error, code: 'INVALID_PIPELINE_TITLES_JSON' })
    } else if (titles.length === 0) {
      warnings.push({ field: `items[${i}].pipeline_titles`, message: 'No pipelines declared — deploy will disconnect every pipeline currently connected to this stream.', code: 'EMPTY_PIPELINE_LIST' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
