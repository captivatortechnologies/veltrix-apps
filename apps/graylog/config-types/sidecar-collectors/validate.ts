import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { SIDECAR_OPERATING_SYSTEMS, SERVICE_TYPES_BY_OS } from './_shared'

/** Collector names may only contain letters, digits, underscores, dots and hyphens (Graylog's own rule). */
const NAME_REGEX = /^[A-Za-z0-9_.-]+$/

/**
 * Validate sidecar-collector items: a non-empty name matching Graylog's naming
 * rule, a known node_operating_system, a service_type valid for that OS
 * (Windows is the only OS that supports "svc"), and a non-empty
 * executable_path. The true identity is the (name, node_operating_system)
 * PAIR — a duplicate pair is flagged, last one wins. Static — no target
 * access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sidecar collector.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = asString(item.fields.name)
    const os = asString(item.fields.node_operating_system).toLowerCase()
    const key = `${name}|${os}`

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Collector name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_REGEX.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Collector name "${name}" may only contain letters, digits, underscores, dots and hyphens.`, code: 'INVALID_NAME' })
    }

    if (!SIDECAR_OPERATING_SYSTEMS.has(os)) {
      errors.push({ field: `items[${i}].node_operating_system`, message: `Operating system must be one of ${[...SIDECAR_OPERATING_SYSTEMS].join(', ')} (got "${os}").`, code: 'INVALID_OS' })
    } else if (name && seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `Collector "${name}" on "${os}" is listed more than once; the last one wins.`, code: 'DUPLICATE_COLLECTOR' })
    } else if (name) {
      seen.add(key)
    }

    const serviceType = asString(item.fields.service_type || 'exec')
    const validServiceTypes = SERVICE_TYPES_BY_OS[os]
    if (validServiceTypes && !validServiceTypes.has(serviceType)) {
      errors.push({ field: `items[${i}].service_type`, message: `Service type "${serviceType}" is not valid for "${os}" — only ${[...validServiceTypes].join(', ')}.`, code: 'INVALID_SERVICE_TYPE' })
    }

    if (!asString(item.fields.executable_path)) {
      errors.push({ field: `items[${i}].executable_path`, message: 'Executable path is required.', code: 'EMPTY_EXECUTABLE_PATH' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
