import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { ACTION_RUNTIMES, TRIGGER_IDS, parseDependencyLine } from './_shared'

/**
 * Validate Auth0 action items: a non-empty name (Auth0 forbids `<`/`>`), a known
 * runtime, a known trigger, non-empty code, and well-formed dependency/secret
 * lines. Static — no target access required. The action name is the upsert
 * identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one action.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const runtime = readString(item.fields.runtime)
    const triggerId = readString(item.fields.trigger_id)
    const code = readString(item.fields.code)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Action name is required.', code: 'EMPTY_NAME' })
    } else {
      if (/[<>]/.test(name)) {
        errors.push({ field: `items[${i}].name`, message: `Action name "${name}" must not contain < or >.`, code: 'INVALID_NAME' })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Action name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    if (runtime && !ACTION_RUNTIMES.has(runtime)) {
      errors.push({
        field: `items[${i}].runtime`,
        message: `Runtime must be one of ${[...ACTION_RUNTIMES].join(', ')} (got "${runtime}").`,
        code: 'INVALID_RUNTIME',
      })
    }

    if (!TRIGGER_IDS.has(triggerId)) {
      errors.push({
        field: `items[${i}].trigger_id`,
        message: `Trigger must be one of ${[...TRIGGER_IDS].join(', ')} (got "${triggerId}").`,
        code: 'INVALID_TRIGGER',
      })
    }

    if (!code) {
      errors.push({ field: `items[${i}].code`, message: 'Code is required.', code: 'EMPTY_CODE' })
    }

    const dependencyLines = typeof item.fields.dependencies === 'string' ? item.fields.dependencies.split(/[\r\n]+/) : []
    dependencyLines.forEach((line) => {
      if (!line.trim()) return
      if (!parseDependencyLine(line)) {
        errors.push({
          field: `items[${i}].dependencies`,
          message: `Dependency "${line.trim()}" must be "<name>@<version>".`,
          code: 'INVALID_DEPENDENCY',
        })
      }
    })

    const secretLines = typeof item.fields.secrets === 'string' ? item.fields.secrets.split(/[\r\n]+/) : []
    secretLines.forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const eq = trimmed.indexOf('=')
      if (eq <= 0) {
        errors.push({ field: `items[${i}].secrets`, message: `Secret "${trimmed}" must be "<name>=<value>".`, code: 'INVALID_SECRET' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
