import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'
import { extractSpecs } from './_shared'

const OID_RE = /^[0-9]+(\.[0-9]+)+$/
const PORT_RE = /^\d{1,5}\/(tcp|udp)$/i

/**
 * Validate note items: non-empty text, an OID-shaped NVT reference, and (if
 * declared) valid port/task/result shapes. Static — no gvmd access required.
 * Notes have no name-based identity (see _shared.ts), so there is no
 * duplicate-name check here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one note.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  extractSpecs(items).forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.text) errors.push({ field: `${prefix}.text`, message: 'Note text is required.', code: 'EMPTY_TEXT' })

    if (!spec.nvtOid) {
      errors.push({ field: `${prefix}.nvtOid`, message: 'An NVT OID is required.', code: 'EMPTY_NVT_OID' })
    } else if (!OID_RE.test(spec.nvtOid)) {
      errors.push({ field: `${prefix}.nvtOid`, message: `"${spec.nvtOid}" is not a valid NVT OID (dotted numeric, e.g. 1.3.6.1.4.1.25623.1.0.12345).`, code: 'INVALID_NVT_OID' })
    }

    if (spec.port && !PORT_RE.test(spec.port)) {
      errors.push({ field: `${prefix}.port`, message: `Port "${spec.port}" must look like "80/tcp" or "53/udp".`, code: 'INVALID_PORT' })
    }
    if (spec.taskId && !UUID_RE.test(spec.taskId)) {
      errors.push({ field: `${prefix}.taskId`, message: 'Task UUID must be a GMP task UUID.', code: 'INVALID_TASK' })
    }
    if (spec.resultId && !UUID_RE.test(spec.resultId)) {
      errors.push({ field: `${prefix}.resultId`, message: 'Result UUID must be a GMP result UUID.', code: 'INVALID_RESULT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
