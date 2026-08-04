import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractEventOrchestrationSpecs, hasStartSet, parseCatchAll, parseOrchestrationSets, START_SET_ID } from './_shared'

/**
 * Validate event orchestration items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - router_sets is required and must shallow-validate (non-empty JSON array of
 *     { id, rules? } objects); a router with no "start" set is flagged since
 *     PagerDuty's Router only ever evaluates rules starting from that set
 *   - router_catch_all, when supplied, must parse to a JSON object with an
 *     "actions" object (a blank value defaults to {"actions":{}})
 *   - global_sets / unrouted_sets, when supplied, use the same shallow validation
 *     as router_sets; their paired catch_all is only validated when the sets
 *     field is itself non-blank (a blank global_sets means Global is unmanaged,
 *     so global_catch_all is ignored — same for unrouted_sets / unrouted_catch_all)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractEventOrchestrationSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one event orchestration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Event orchestration name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Event orchestration name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    const routerSets = parseOrchestrationSets(spec.routerSetsJson)
    if (routerSets.error) {
      errors.push({ field: `${prefix}.router_sets`, message: `Router sets ${routerSets.error}.`, code: 'INVALID_ROUTER_SETS' })
    } else if (routerSets.sets && !hasStartSet(routerSets.sets)) {
      warnings.push({
        field: `${prefix}.router_sets`,
        message: `Router sets should include a set with id "${START_SET_ID}" — PagerDuty's Router only evaluates rules starting from "${START_SET_ID}".`,
        code: 'MISSING_START_SET',
      })
    }

    const routerCatchAll = parseCatchAll(spec.routerCatchAllJson)
    if (routerCatchAll.error) {
      errors.push({
        field: `${prefix}.router_catch_all`,
        message: `Router catch_all ${routerCatchAll.error}.`,
        code: 'INVALID_ROUTER_CATCH_ALL',
      })
    }

    if (spec.globalSetsJson.trim()) {
      const globalSets = parseOrchestrationSets(spec.globalSetsJson)
      if (globalSets.error) {
        errors.push({ field: `${prefix}.global_sets`, message: `Global sets ${globalSets.error}.`, code: 'INVALID_GLOBAL_SETS' })
      }
      const globalCatchAll = parseCatchAll(spec.globalCatchAllJson)
      if (globalCatchAll.error) {
        errors.push({
          field: `${prefix}.global_catch_all`,
          message: `Global catch_all ${globalCatchAll.error}.`,
          code: 'INVALID_GLOBAL_CATCH_ALL',
        })
      }
    }

    if (spec.unroutedSetsJson.trim()) {
      const unroutedSets = parseOrchestrationSets(spec.unroutedSetsJson)
      if (unroutedSets.error) {
        errors.push({
          field: `${prefix}.unrouted_sets`,
          message: `Unrouted sets ${unroutedSets.error}.`,
          code: 'INVALID_UNROUTED_SETS',
        })
      }
      const unroutedCatchAll = parseCatchAll(spec.unroutedCatchAllJson)
      if (unroutedCatchAll.error) {
        errors.push({
          field: `${prefix}.unrouted_catch_all`,
          message: `Unrouted catch_all ${unroutedCatchAll.error}.`,
          code: 'INVALID_UNROUTED_CATCH_ALL',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
