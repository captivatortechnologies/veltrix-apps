import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseScopeEntries } from './_shared'

// A scope entry is an IPv4/IPv6 address, a CIDR, a hostname, or a hyphen range.
// Loose on purpose — runZero is the authority; this only flags obvious typos.
const SCOPE_ENTRY_RE = /^[A-Za-z0-9._:/\-]+$/

/**
 * Validate Site items: a non-empty name is required; scope entries are checked
 * loosely for obviously invalid characters (warning only — runZero validates the
 * scope authoritatively at deploy time). Static — no target access required. The
 * name doubles as the site identity, so a duplicate name is flagged (last wins).
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
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Site name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Site name ${name} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }

    for (const entry of parseScopeEntries(item.fields.subnets)) {
      if (!SCOPE_ENTRY_RE.test(entry)) {
        warnings.push({
          field: `items[${i}].subnets`,
          message: `Scope entry "${entry}" does not look like a valid CIDR / host — runZero may reject it.`,
          code: 'SUSPECT_SCOPE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
