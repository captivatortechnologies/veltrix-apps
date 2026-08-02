import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractSourceNatRuleSpecs, isValidIpProtocol, type SourceNatRuleSpec } from './_shared'

/**
 * Validate OPNsense source-nat (outbound NAT) configurations: a required
 * description (this app's own identity/label choice), a required interface,
 * a supported ipprotocol, a sequence in [1,999999], and no embedded commas in
 * `categories` (the one comma-joined list field this config type has — every
 * other list-shaped field on `snatrules.rule` is a SINGLE value, unlike
 * firewall-rules — see _shared.ts's module doc). Referenced category names
 * are resolved live at deploy time, same deferred pattern as firewall-rules.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: SourceNatRuleSpec[] = extractSourceNatRuleSpecs(ctx.canvas)

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }
    if (!spec.interfaceName) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required', code: 'required' })
    } else if (spec.interfaceName.includes(',')) {
      errors.push({
        field: `${prefix}.interface`,
        message: 'Interface is a single value on this model — declare one interface per rule',
        code: 'invalid_entry',
      })
    }
    if (!isValidIpProtocol(spec.ipprotocol)) {
      errors.push({ field: `${prefix}.ipprotocol`, message: `IP protocol must be inet (IPv4) or inet6 (IPv6) (got "${spec.ipprotocol}")`, code: 'invalid_value' })
    }
    if (!Number.isInteger(spec.sequence) || spec.sequence < 1 || spec.sequence > 999999) {
      errors.push({ field: `${prefix}.sequence`, message: 'Sequence must be an integer between 1 and 999999', code: 'invalid_value' })
    }
    spec.categories.forEach((entry, j) => {
      if (entry.includes(',')) {
        errors.push({ field: `${prefix}.categories[${j}]`, message: `"${entry}" must not contain a comma`, code: 'invalid_entry' })
      }
    })
    if (spec.nonat && (spec.target || spec.targetPort)) {
      warnings.push({
        field: `${prefix}.target`,
        message: '"No NAT" rules exclude traffic from translation — a Target/Target Port is ignored when No NAT is enabled',
        code: 'ignored_field',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
