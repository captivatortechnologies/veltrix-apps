import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractCommandSpecs, COMMAND_TYPES } from './_shared'

const MAX_TIMEOUT_SECONDS = 86400 // JumpCloud's documented maximum (1 day)

/**
 * Validate Command items: a non-empty, unique name (the logical identity), a
 * non-empty command body, a recognized OS, and a plausible timeout. Static — no
 * target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractCommandSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Command.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Command name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'Command name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate Command "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.command) {
      errors.push({ field: `${prefix}.command`, message: `"${spec.name || 'command'}" requires command text to execute.`, code: 'EMPTY_COMMAND' })
    } else if (spec.command.length > 10_000) {
      errors.push({ field: `${prefix}.command`, message: 'command text is truncated by JumpCloud at 10,000 characters.', code: 'COMMAND_TOO_LONG' })
    }

    if (!(COMMAND_TYPES as readonly string[]).includes(spec.commandType)) {
      errors.push({ field: `${prefix}.commandType`, message: `commandType must be one of: ${COMMAND_TYPES.join(', ')}.`, code: 'INVALID_OS' })
    }

    if (spec.timeout) {
      const n = Number(spec.timeout)
      if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_SECONDS) {
        errors.push({ field: `${prefix}.timeout`, message: `timeout must be a number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}.`, code: 'INVALID_TIMEOUT' })
      }
    }

    if (!spec.user && spec.launchType.toLowerCase() !== 'trigger') {
      warnings.push({
        field: `${prefix}.user`,
        message: `"${spec.name || 'command'}" has no Run As user set — JumpCloud requires one unless the command is trigger-launched.`,
        code: 'NO_USER',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
