import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  extractFilterRuleSpecs,
  isValidAction,
  isValidDirection,
  isValidIpProtocol,
  isValidStateType,
  type FilterRuleSpec,
} from './_shared'

/** Fields whose entries are comma-joined on the wire (see buildFilterRuleBody) — a comma inside one would corrupt the join. */
function rejectEmbeddedCommas(prefix: string, field: string, entries: string[], errors: ValidationResult['errors']) {
  entries.forEach((entry, j) => {
    if (entry.includes(',')) {
      errors.push({
        field: `${prefix}.${field}[${j}]`,
        message: `"${entry}" must not contain a comma`,
        code: 'invalid_entry',
      })
    }
  })
}

/**
 * Validate OPNsense firewall-rules configurations: a required description
 * (this app's own identity/label choice — see _shared.ts's module doc), a
 * supported action/direction/ipprotocol/statetype, a sequence in [1,999999],
 * and no embedded commas in any comma-joined list field (interface,
 * source/destination networks, categories). Referenced category names are
 * NOT verified to exist here (that needs a live lookup) — deploy resolves and
 * fails clearly on an unknown category, the same deferred-to-deploy pattern
 * this codebase's Check Point access-rules type uses for its own by-name
 * object references.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: FilterRuleSpec[] = extractFilterRuleSpecs(ctx.canvas)

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }
    if (!isValidAction(spec.action)) {
      errors.push({ field: `${prefix}.action`, message: `Action must be one of pass, block, reject (got "${spec.action}")`, code: 'invalid_value' })
    }
    if (!isValidDirection(spec.direction)) {
      errors.push({ field: `${prefix}.direction`, message: `Direction must be one of in, out, any (got "${spec.direction}")`, code: 'invalid_value' })
    }
    if (!isValidIpProtocol(spec.ipprotocol)) {
      errors.push({ field: `${prefix}.ipprotocol`, message: `IP protocol must be inet (IPv4) or inet6 (IPv6) (got "${spec.ipprotocol}")`, code: 'invalid_value' })
    }
    if (!isValidStateType(spec.statetype)) {
      errors.push({
        field: `${prefix}.statetype`,
        message: `State type must be one of keep, sloppy, modulate, synproxy, none (got "${spec.statetype}")`,
        code: 'invalid_value',
      })
    }
    if (!Number.isInteger(spec.sequence) || spec.sequence < 1 || spec.sequence > 999999) {
      errors.push({ field: `${prefix}.sequence`, message: 'Sequence must be an integer between 1 and 999999', code: 'invalid_value' })
    }

    rejectEmbeddedCommas(prefix, 'interface', spec.interface, errors)
    rejectEmbeddedCommas(prefix, 'source_net', spec.sourceNet, errors)
    rejectEmbeddedCommas(prefix, 'destination_net', spec.destinationNet, errors)
    rejectEmbeddedCommas(prefix, 'categories', spec.categories, errors)

    if (spec.interface.length > 1 && !spec.interfacenot) {
      warnings.push({
        field: `${prefix}.interface`,
        message: 'More than one interface makes this a floating rule (evaluated before single-interface rules) — see README.md on rule ordering',
        code: 'floating_rule',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
