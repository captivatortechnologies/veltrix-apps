import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate site items: a non-empty site name (its identity), a callback
 * interval within Secret Server's documented 30-300 second range, and proxy
 * ports present only (and required) when their proxy is enabled. Static — no
 * target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one site.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields ?? {}
    const name = String(f.siteName ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].siteName`, message: 'Site name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (name.length > 255) {
      errors.push({ field: `items[${i}].siteName`, message: `Site name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    const key = name.toLowerCase()
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].siteName`,
        message: `Site "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_SITE',
      })
    } else {
      seen.add(key)
    }

    const interval = f.callbackInterval === undefined || f.callbackInterval === '' ? 300 : Number(f.callbackInterval)
    if (!Number.isFinite(interval) || interval < 30 || interval > 300) {
      errors.push({
        field: `items[${i}].callbackInterval`,
        message: 'Engine callback interval must be between 30 and 300 seconds.',
        code: 'INVALID_CALLBACK_INTERVAL',
      })
    }

    const rdpEnabled = f.enableRdpProxy === true || String(f.enableRdpProxy).toLowerCase() === 'true'
    if (rdpEnabled && (f.rdpProxyPort === undefined || f.rdpProxyPort === '')) {
      errors.push({ field: `items[${i}].rdpProxyPort`, message: 'RDP proxy port is required when the RDP proxy is enabled.', code: 'MISSING_RDP_PORT' })
    }

    const sshEnabled = f.enableSshProxy === true || String(f.enableSshProxy).toLowerCase() === 'true'
    if (sshEnabled && (f.sshProxyPort === undefined || f.sshProxyPort === '')) {
      errors.push({ field: `items[${i}].sshProxyPort`, message: 'SSH proxy port is required when the SSH proxy is enabled.', code: 'MISSING_SSH_PORT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
