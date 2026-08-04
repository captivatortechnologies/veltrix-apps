import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { extractPipelineName, RESERVED_PIPELINE_NAME } from './_shared'

/**
 * Validate pipeline items: a non-empty title (the identity — a duplicate is
 * flagged, last one wins), a non-empty DSL source, a title that matches the
 * `pipeline "NAME"` declared in the source (Graylog derives the stored title
 * from the parsed source, exactly like pipeline-rules), and that the name is
 * not the "Default Routing" pipeline Graylog reserves for itself. Static — no
 * target access; whether the pipeline references rules that don't exist on the
 * target surfaces as a deploy-time parse error from Graylog.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one pipeline.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)
    const source = String(item.fields.source ?? '').trim()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Pipeline title is required.', code: 'EMPTY_TITLE' })
    } else if (title === RESERVED_PIPELINE_NAME) {
      errors.push({ field: `items[${i}].title`, message: `"${RESERVED_PIPELINE_NAME}" is reserved by Graylog for its built-in input-routing pipeline.`, code: 'RESERVED_NAME' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Pipeline title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!source) {
      errors.push({ field: `items[${i}].source`, message: 'Pipeline source (the pipeline DSL) is required.', code: 'EMPTY_SOURCE' })
      return
    }

    const pipelineName = extractPipelineName(source)
    if (!pipelineName) {
      errors.push({ field: `items[${i}].source`, message: 'Pipeline source must declare a pipeline, e.g. pipeline "my-pipeline" stage 0 match either rule "my-rule" end.', code: 'NO_PIPELINE_NAME' })
    } else if (title && pipelineName !== title) {
      errors.push({
        field: `items[${i}].title`,
        message: `Title "${title}" must match the pipeline name in the source ("${pipelineName}") — Graylog names the pipeline from its DSL.`,
        code: 'PIPELINE_NAME_MISMATCH',
      })
    }

    for (const kw of ['stage', 'end']) {
      if (!new RegExp(`\\b${kw}\\b`).test(source)) {
        warnings.push({ field: `items[${i}].source`, message: `Pipeline source is missing the "${kw}" keyword — a pipeline reads: pipeline "..." stage 0 match either rule "..." end.`, code: 'MISSING_KEYWORD' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
