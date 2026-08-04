import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  BACKENDS,
  DEVICE_CLASSES,
  NOT_CONFIGURED_ACTIONS,
  STAGE_TYPES,
  UUID_PATTERN,
  USER_FIELDS,
  readStringList,
} from './_shared'

/**
 * Validate authentik Stage items: a non-empty name (the upsert identity
 * within the item's type), a known type, `backends` required for
 * Type = Password (the only type-specific required field beyond `name` per
 * the *StageRequest schemas), and known enum values for user_fields /
 * backends / device_classes / not_configured_action when set. Static (no
 * target access).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one stage.', code: 'EMPTY' })
  }

  const seenByType = new Map<string, Set<string>>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Stage name is required.', code: 'EMPTY_NAME' })
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Stage type is required.', code: 'EMPTY_TYPE' })
    } else if (!STAGE_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Unsupported stage type "${type}".`, code: 'INVALID_TYPE' })
    }

    if (type === 'identification') {
      for (const uf of readStringList(item.fields.user_fields)) {
        if (!USER_FIELDS.has(uf)) {
          errors.push({ field: `items[${i}].user_fields`, message: `"${uf}" is not a valid user field (email, username, upn).`, code: 'INVALID_USER_FIELD' })
        }
      }
      for (const flowKey of ['enrollment_flow', 'recovery_flow'] as const) {
        const v = String(item.fields[flowKey] ?? '').trim()
        if (v && !UUID_PATTERN.test(v)) {
          errors.push({ field: `items[${i}].${flowKey}`, message: `"${v}" is not a valid UUID.`, code: 'INVALID_FLOW_UUID' })
        }
      }
    }

    if (type === 'password') {
      const backends = readStringList(item.fields.backends)
      if (backends.length === 0) {
        errors.push({ field: `items[${i}].backends`, message: 'At least one backend is required for Type = Password.', code: 'EMPTY_BACKENDS' })
      }
      for (const b of backends) {
        if (!BACKENDS.has(b)) {
          errors.push({ field: `items[${i}].backends`, message: `"${b}" is not a known authentication backend.`, code: 'INVALID_BACKEND' })
        }
      }
    }

    if (type === 'authenticator-validate') {
      for (const dc of readStringList(item.fields.device_classes)) {
        if (!DEVICE_CLASSES.has(dc)) {
          errors.push({ field: `items[${i}].device_classes`, message: `"${dc}" is not a known device class.`, code: 'INVALID_DEVICE_CLASS' })
        }
      }
      const nca = String(item.fields.not_configured_action ?? '').trim()
      if (nca && !NOT_CONFIGURED_ACTIONS.has(nca)) {
        errors.push({ field: `items[${i}].not_configured_action`, message: `"${nca}" must be one of skip, deny, configure.`, code: 'INVALID_NOT_CONFIGURED_ACTION' })
      }
    }

    if (name && type) {
      const key = name
      const seen = seenByType.get(type) ?? new Set<string>()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Stage "${name}" (${type}) is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
      seenByType.set(type, seen)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
