import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CRIBL_ID_RE, parseRoutes, ROUTES_TABLE_DEFAULT_ID } from './_shared'
import { resolveWorkerGroup } from '../../lib/criblCommon'

/**
 * Validate the routing table item(s): a well-formed table id (defaults to
 * "default"), and a `routes` value that parses to a JSON array of Route objects.
 * Static — no target access. One table per Worker Group, so a second item for
 * the same group+id is flagged (last wins). An empty routing table is warned
 * (it would drop all data).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const settings = ctx.settings ?? {}

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one routing table.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const id = String(item.fields.id ?? '').trim() || ROUTES_TABLE_DEFAULT_ID
    const group = resolveWorkerGroup(item.fields, settings)
    const scopedId = `${group}/${id}`

    if (!CRIBL_ID_RE.test(id)) {
      errors.push({
        field: `items[${i}].id`,
        message: `Routing table ID "${id}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_ID',
      })
    } else if (seen.has(scopedId)) {
      warnings.push({
        field: `items[${i}].id`,
        message: `Routing table ${id} is listed more than once for group ${group || '(single-instance)'}; the last one wins.`,
        code: 'DUPLICATE_ID',
      })
    } else {
      seen.add(scopedId)
    }

    const { routes, error } = parseRoutes(item.fields.routes)
    if (error) {
      errors.push({ field: `items[${i}].routes`, message: error, code: 'INVALID_ROUTES' })
    } else if (routes) {
      if (routes.length === 0) {
        warnings.push({
          field: `items[${i}].routes`,
          message: `Routing table ${id} has no Routes — events reaching it are dropped.`,
          code: 'EMPTY_ROUTES',
        })
      }
      routes.forEach((route, ri) => {
        if (!route || typeof route !== 'object' || Array.isArray(route)) {
          errors.push({ field: `items[${i}].routes[${ri}]`, message: 'Each route must be a JSON object.', code: 'INVALID_ROUTE' })
        } else if (!String(route.name ?? '').trim()) {
          warnings.push({ field: `items[${i}].routes[${ri}]`, message: `Route ${ri} in table ${id} has no name.`, code: 'ROUTE_NO_NAME' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
