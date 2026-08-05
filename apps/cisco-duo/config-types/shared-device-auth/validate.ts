import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseList, normalizeIdObjects } from '../../lib/duo'

// --- Cisco Duo Shared Device Authentication constraints ----------------------
//
// Shared Device Authentication configures Duo Desktop kiosk / shared-workstation
// auth — full CRUD via /admin/v1/desktop_authenticators/shared_device_auth. The
// update (PUT) request MUST be a JSON body per Duo's own docs, so this type is
// V5(JSON)-signed end to end (create/update/delete/list all use the requestV5
// helpers already in lib/duo.ts, the same ones Policies and Passport use).
//
// Duo addresses a configuration by an opaque shared_device_key with no
// lookup-by-name, so — matching every other config type in this app — the item
// is matched to a live one by NAME and the key is stored for rename-safety.
//
// Each configuration pairs one or more Duo GROUPS (`group_id_list`, this app's
// own `groups` config type creates those) with one or more Trusted Endpoints
// MANAGEMENT INTEGRATIONS (`trusted_endpoint_integration_id_list`). Management
// integrations are provisioned by enrolling a device-management system (Duo
// Desktop, an MDM, etc.) in the Duo Admin Panel's Trusted Endpoints setup — the
// Admin API has no endpoint to create or list them, only to reference their ids
// here, so operators must copy the id from the Admin Panel.

export const MAX_NAME_LENGTH = 255

export interface SharedDeviceAuthSpec {
  itemId?: string
  /** name — the logical identity (Duo addresses these by shared_device_key). */
  name: string
  active: boolean
  /** Duo group ids (`group_id_list`) this configuration applies to. */
  groupIds: string[]
  /** Trusted Endpoints management integration ids (`trusted_endpoint_integration_id_list`). */
  trustedEndpointIntegrationIds: string[]
}

/** A group entry embedded in a shared device auth response. */
export interface LiveSharedDeviceAuthGroup {
  group_id?: string
  name?: string
}

/** A management integration entry embedded in a shared device auth response. */
export interface LiveTrustedEndpointIntegration {
  trusted_endpoint_integration_id?: string
  name?: string
}

/** A configuration as returned by GET /admin/v1/desktop_authenticators/shared_device_auth. */
export interface LiveSharedDeviceAuth {
  shared_device_key?: string
  name?: string
  active?: boolean
  groups?: Array<LiveSharedDeviceAuthGroup | string> | null
  trusted_endpoint_integrations?: Array<LiveTrustedEndpointIntegration | string> | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** `active` defaults to true (Duo's own create default of `1`) when unset. */
function asActive(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (v === undefined || v === null || v === '') return true
  return v === true || v === 'true' || v === 1 || v === '1'
}

export function extractSharedDeviceAuthSpecs(canvas: CanvasSnapshot): SharedDeviceAuthSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      active: asActive(f.active),
      groupIds: parseList(f.group_ids),
      trustedEndpointIntegrationIds: parseList(f.trusted_endpoint_integration_ids),
    }
  })
}

/** Group ids from a live response's `groups` array. */
export function liveGroupIds(live: LiveSharedDeviceAuth): string[] {
  return normalizeIdObjects(live.groups, 'group_id')
}

/** Management integration ids from a live response's `trusted_endpoint_integrations` array. */
export function liveTrustedEndpointIntegrationIds(live: LiveSharedDeviceAuth): string[] {
  return normalizeIdObjects(live.trusted_endpoint_integrations, 'trusted_endpoint_integration_id')
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSharedDeviceAuthSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required to identify this configuration across deploys', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate shared device authentication configuration "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.groupIds.length === 0) {
      errors.push({
        field: `${prefix}.group_ids`,
        message: 'At least one group id is required — the Duo Admin API rejects a configuration with no groups',
        code: 'required',
      })
    }
    if (spec.trustedEndpointIntegrationIds.length === 0) {
      errors.push({
        field: `${prefix}.trusted_endpoint_integration_ids`,
        message: 'At least one Trusted Endpoints management integration id is required — the Duo Admin API rejects a configuration with none',
        code: 'required',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
