import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { TARGET_TYPES } from './_shared'

/**
 * Validate protocol-mapper items: a known targetType, a non-empty targetRef, a
 * non-empty mapper name with no whitespace, a known protocol, and a required
 * protocolMapper type id. Static (no target access — the referenced client /
 * client scope's existence is checked at deploy time). The identity is the
 * COMPOSITE (targetType, targetRef, name): the same mapper name may
 * legitimately exist on a client AND a client scope, or on two different
 * clients, so a duplicate is only flagged on the full triple.
 */
const NAME_RE = /^[^\s]+$/
const PROTOCOLS = new Set(['openid-connect', 'saml'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one protocol mapper.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const targetType = readString(item.fields.targetType)
    const targetRef = readString(item.fields.targetRef)
    const name = readString(item.fields.name)
    const protocol = readString(item.fields.protocol)
    const protocolMapper = readString(item.fields.protocolMapper)

    if (!TARGET_TYPES.has(targetType)) {
      errors.push({
        field: `items[${i}].targetType`,
        message: `Target type must be one of client, client-scope (got "${targetType}").`,
        code: 'INVALID_TARGET_TYPE',
      })
    }

    if (!targetRef) {
      errors.push({ field: `items[${i}].targetRef`, message: 'Target is required.', code: 'EMPTY_TARGET_REF' })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Mapper name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Mapper name "${name}" must not contain whitespace.`,
        code: 'INVALID_NAME',
      })
    }

    if (!PROTOCOLS.has(protocol)) {
      errors.push({
        field: `items[${i}].protocol`,
        message: `Protocol must be one of openid-connect, saml (got "${protocol}").`,
        code: 'INVALID_PROTOCOL',
      })
    }

    if (!protocolMapper) {
      errors.push({
        field: `items[${i}].protocolMapper`,
        message: 'Mapper type is required.',
        code: 'EMPTY_PROTOCOL_MAPPER',
      })
    }

    if (targetType && targetRef && name) {
      const key = `${targetType}::${targetRef}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Mapper "${name}" on ${targetType} "${targetRef}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_MAPPER',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
