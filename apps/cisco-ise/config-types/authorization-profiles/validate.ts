import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, ACCESS_TYPES, parseAdvancedAttributes, specFromItem } from './_shared'

/**
 * Validate authorization profile items: a non-empty, uniquely-named profile
 * with a valid access type, a VLAN tag in RFC 2868's 0-31 range when set, and
 * — when advanced attributes JSON is provided — a well-formed array of
 * `{ leftHandSideDictionaryAttribute, rightHandSideAttributeValue }` pairs.
 * Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one authorization profile.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const rawAccessType = String(item.fields.access_type ?? '').trim().toUpperCase()

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Profile name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `Profile name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Profile name "${spec.name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (rawAccessType && !ACCESS_TYPES.has(rawAccessType)) {
      errors.push({
        field: `items[${i}].access_type`,
        message: `Access type must be one of ${[...ACCESS_TYPES].join(', ')} (got "${rawAccessType}").`,
        code: 'INVALID_ACCESS_TYPE',
      })
    }

    if (spec.vlanTag != null && (spec.vlanTag < 0 || spec.vlanTag > 31)) {
      errors.push({
        field: `items[${i}].vlan_tag`,
        message: `VLAN tag must be between 0 and 31 per RFC 2868 (got ${spec.vlanTag}).`,
        code: 'INVALID_VLAN_TAG',
      })
    }
    if (spec.vlanTag != null && !spec.vlanName) {
      warnings.push({
        field: `items[${i}].vlan_tag`,
        message: 'A VLAN Tag is set but VLAN Name / ID is blank — the tag has no effect without a VLAN.',
        code: 'VLAN_TAG_WITHOUT_NAME',
      })
    }

    const { error: attrError, attributes } = parseAdvancedAttributes(item.fields.advanced_attributes)
    if (attrError) {
      errors.push({ field: `items[${i}].advanced_attributes`, message: attrError, code: 'INVALID_ADVANCED_ATTRIBUTES_JSON' })
    } else {
      attributes.forEach((attr, a) => {
        if (!attr.leftHandSideDictionaryAttribute) {
          errors.push({
            field: `items[${i}].advanced_attributes[${a}]`,
            message: 'Each advanced attribute needs a "leftHandSideDictionaryAttribute" (e.g. "Radius:Session-Timeout").',
            code: 'ADVANCED_ATTRIBUTE_MISSING_LHS',
          })
        }
      })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
