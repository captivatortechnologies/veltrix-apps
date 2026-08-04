import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'
import { ALERT_EVENTS, ALERT_CONDITIONS, ALERT_METHODS } from '../../lib/gmp/alerts'

/**
 * Validate alert items: a non-empty name, a recognised event/condition/method
 * (secret-free methods only), and the minimal method-specific data each method
 * needs to be useful (e.g. Email needs a To Address). Static — no gvmd access
 * required. Alert names double as the upsert identity, so a duplicate name is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one alert.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields
    const name = String(f.name ?? '').trim()
    const event = String(f.event ?? '').trim()
    const condition = String(f.condition ?? '').trim()
    const method = String(f.method ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Alert name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Alert name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!(ALERT_EVENTS as readonly string[]).includes(event)) {
      errors.push({ field: `items[${i}].event`, message: `Event must be one of: ${ALERT_EVENTS.join(', ')}.`, code: 'INVALID_EVENT' })
    }
    if (!(ALERT_CONDITIONS as readonly string[]).includes(condition)) {
      errors.push({ field: `items[${i}].condition`, message: `Condition must be one of: ${ALERT_CONDITIONS.join(', ')}.`, code: 'INVALID_CONDITION' })
    }
    if (!(ALERT_METHODS as readonly string[]).includes(method)) {
      errors.push({
        field: `items[${i}].method`,
        message: `Method must be one of: ${ALERT_METHODS.join(', ')} (SCP/SMB/TippingPoint SMS/verinice Connector are not supported — they require a GMP credential this app does not manage).`,
        code: 'INVALID_METHOD',
      })
    }

    if (condition === 'Severity at least' && (f.conditionSeverity === undefined || f.conditionSeverity === '')) {
      errors.push({ field: `items[${i}].conditionSeverity`, message: 'A minimum severity is required for "Severity at least".', code: 'EMPTY_CONDITION_SEVERITY' })
    }
    if ((condition === 'Filter count changed' || condition === 'Filter count at least') && !String(f.conditionFilterId ?? '').trim()) {
      errors.push({ field: `items[${i}].conditionFilterId`, message: `A filter UUID is required for "${condition}".`, code: 'EMPTY_CONDITION_FILTER' })
    } else if (f.conditionFilterId && !UUID_RE.test(String(f.conditionFilterId).trim())) {
      errors.push({ field: `items[${i}].conditionFilterId`, message: 'Filter UUID must be a GMP filter UUID.', code: 'INVALID_CONDITION_FILTER' })
    }

    if (method === 'Email' && !String(f.emailTo ?? '').trim()) {
      errors.push({ field: `items[${i}].emailTo`, message: 'A To Address is required for the Email method.', code: 'EMPTY_EMAIL_TO' })
    }
    if (method === 'HTTP Get' && !String(f.httpUrl ?? '').trim()) {
      errors.push({ field: `items[${i}].httpUrl`, message: 'A URL is required for the HTTP Get method.', code: 'EMPTY_HTTP_URL' })
    }
    if (method === 'Start Task') {
      const taskId = String(f.startTaskId ?? '').trim()
      if (!taskId) errors.push({ field: `items[${i}].startTaskId`, message: 'A task UUID is required for the Start Task method.', code: 'EMPTY_START_TASK' })
      else if (!UUID_RE.test(taskId)) errors.push({ field: `items[${i}].startTaskId`, message: 'Task UUID must be a GMP task UUID.', code: 'INVALID_START_TASK' })
    }
    if (method === 'SNMP' && !String(f.snmpAgent ?? '').trim()) {
      errors.push({ field: `items[${i}].snmpAgent`, message: 'An SNMP destination host is required for the SNMP method.', code: 'EMPTY_SNMP_AGENT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
