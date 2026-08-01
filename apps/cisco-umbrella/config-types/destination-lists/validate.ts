import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  ACCESS_VALUES,
  MAX_DESTINATIONS,
  MAX_NAME_LENGTH,
  classifyDestination,
  extractDestinationListSpecs,
} from './_shared'

/**
 * Validate destination-list items: a unique non-empty name within the length
 * limit, a known access mode (allow/block), and destinations within Umbrella's
 * per-list cap. Static — no target access required. Also warns when a
 * destination's type is unsupported for the chosen access mode (URLs are
 * block-only; IPv4 is allow-only) — Umbrella rejects those at deploy.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDestinationListSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one destination list.', code: 'EMPTY' })
  }

  const seenNames = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate destination list "${spec.name}" — each may only be declared once per canvas.`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!ACCESS_VALUES.has(spec.access)) {
      errors.push({
        field: `${prefix}.access`,
        message: `Access must be one of allow, block (got "${spec.access}").`,
        code: 'invalid_access',
      })
    }

    if (spec.destinations.length > MAX_DESTINATIONS) {
      errors.push({
        field: `${prefix}.destinations`,
        message: `A destination list may contain at most ${MAX_DESTINATIONS} destinations (got ${spec.destinations.length}).`,
        code: 'too_many_destinations',
      })
    }

    if (spec.destinations.length === 0) {
      warnings.push({
        field: `${prefix}.destinations`,
        message: 'This destination list has no destinations — it will be created (or emptied) with none.',
        code: 'empty_destinations',
      })
    }

    for (const destination of spec.destinations) {
      const type = classifyDestination(destination)
      if (type === 'url' && spec.access === 'allow') {
        warnings.push({
          field: `${prefix}.destinations`,
          message: `"${destination}" looks like a URL — Umbrella only supports URLs on block lists, not allow lists.`,
          code: 'url_on_allow_list',
        })
      } else if (type === 'ipv4' && spec.access === 'block') {
        warnings.push({
          field: `${prefix}.destinations`,
          message: `"${destination}" looks like an IPv4 address — Umbrella only supports IPs on allow lists, not block lists.`,
          code: 'ip_on_block_list',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
