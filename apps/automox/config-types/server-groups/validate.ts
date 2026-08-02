import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { validateUniqueName } from '../lib/validation'
import { extractServerGroupSpecs, TRI_STATE_OPTIONS } from './_shared'

const REFRESH_INTERVAL_MIN = 360
const REFRESH_INTERVAL_MAX = 1440
const UI_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * Validate Server Group items: a non-empty, unique name (the logical
 * identity), a Parent Server Group ID (required by Automox for every group —
 * see canvas.yaml), a refresh interval in Automox's supported 360-1440 minute
 * range, a well-formed UI color, WSUS server required when forcing WSUS, and
 * numeric Linked Policy IDs. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractServerGroupSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Server Group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    validateUniqueName(spec.name, prefix, seen, errors, { label: 'Server Group name' })

    if (spec.parentServerGroupId == null || spec.parentServerGroupId <= 0) {
      errors.push({
        field: `${prefix}.parent_server_group_id`,
        message: 'Parent Server Group ID is required — use your organization\'s Default Group id to make this a top-level group.',
        code: 'REQUIRED',
      })
    }

    if (spec.refreshInterval < REFRESH_INTERVAL_MIN || spec.refreshInterval > REFRESH_INTERVAL_MAX) {
      errors.push({
        field: `${prefix}.refresh_interval`,
        message: `Refresh Interval must be between ${REFRESH_INTERVAL_MIN} and ${REFRESH_INTERVAL_MAX} minutes (got ${spec.refreshInterval}).`,
        code: 'INVALID_REFRESH_INTERVAL',
      })
    }

    if (spec.uiColor && !UI_COLOR_RE.test(spec.uiColor)) {
      errors.push({
        field: `${prefix}.ui_color`,
        message: `UI Color "${spec.uiColor}" must be a 6-digit hex color, e.g. "#0072CE".`,
        code: 'INVALID_UI_COLOR',
      })
    }

    if (!TRI_STATE_OPTIONS.includes(spec.enableOsAutoUpdate)) {
      errors.push({
        field: `${prefix}.enable_os_auto_update`,
        message: `Unsupported value "${spec.enableOsAutoUpdate}". Expected one of: ${TRI_STATE_OPTIONS.join(', ')}.`,
        code: 'INVALID_TRI_STATE',
      })
    }
    if (!TRI_STATE_OPTIONS.includes(spec.enableWsus)) {
      errors.push({
        field: `${prefix}.enable_wsus`,
        message: `Unsupported value "${spec.enableWsus}". Expected one of: ${TRI_STATE_OPTIONS.join(', ')}.`,
        code: 'INVALID_TRI_STATE',
      })
    } else if (spec.enableWsus === 'enable' && !spec.wsusServer) {
      errors.push({
        field: `${prefix}.wsus_server`,
        message: 'WSUS Server is required when WSUS is set to "Force WSUS".',
        code: 'REQUIRED',
      })
    }

    if (spec.policyIdsRaw.length !== spec.policyIds.length) {
      errors.push({
        field: `${prefix}.policies`,
        message: 'Linked Policy IDs must all be non-negative integers.',
        code: 'INVALID_POLICY_IDS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
