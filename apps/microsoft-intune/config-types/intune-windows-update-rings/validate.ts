import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { AssignmentSpec } from '../../lib/assignments'

/** The @odata.type that identifies a Windows Update ring among all deviceConfigurations. */
export const WINDOWS_UPDATE_RING_ODATA_TYPE = '#microsoft.graph.windowsUpdateForBusinessConfiguration'

/** automaticUpdateMode (Graph enum). */
export const AUTOMATIC_UPDATE_MODES = [
  'userDefined',
  'notifyDownload',
  'autoInstallAtMaintenanceTime',
  'autoInstallAndRebootAtMaintenanceTime',
  'autoInstallAndRebootAtScheduledTime',
  'autoInstallAndRebootWithoutEndUserControl',
  'windowsDefault',
] as const

/** businessReadyUpdatesOnly / windowsUpdateType (Graph enum). */
export const BUSINESS_READY_UPDATE_TYPES = [
  'userDefined',
  'all',
  'businessReadyOnly',
  'windowsInsiderBuildFast',
  'windowsInsiderBuildSlow',
  'windowsInsiderBuildRelease',
] as const

/** deliveryOptimizationMode / windowsDeliveryOptimizationMode (Graph enum). */
export const DELIVERY_OPTIMIZATION_MODES = [
  'userDefined',
  'httpOnly',
  'httpWithPeeringNat',
  'httpWithPeeringPrivateGroup',
  'httpWithInternetPeering',
  'simpleDownload',
  'bypassMode',
] as const

type RingFieldType = 'number' | 'boolean' | 'enum'

interface RingFieldDef {
  /** Canvas field key — kept identical to the Graph property for a trivial mapping. */
  key: string
  label: string
  type: RingFieldType
  min?: number
  max?: number
  options?: readonly string[]
}

/**
 * The writable fields this ring manages. The canvas key equals the Graph property,
 * so extract/deploy/drift all key off this one list (DRY). Ranges verified against
 * the windowsUpdateForBusinessConfiguration resource; feature-update deferral is
 * 0-365 (the Intune UI / WUfB range — the beta docs' "0-30" is a copy-paste bug).
 */
export const RING_FIELDS: RingFieldDef[] = [
  { key: 'qualityUpdatesDeferralPeriodInDays', label: 'Quality updates deferral (days)', type: 'number', min: 0, max: 30 },
  { key: 'featureUpdatesDeferralPeriodInDays', label: 'Feature updates deferral (days)', type: 'number', min: 0, max: 365 },
  { key: 'automaticUpdateMode', label: 'Automatic update mode', type: 'enum', options: AUTOMATIC_UPDATE_MODES },
  { key: 'businessReadyUpdatesOnly', label: 'Servicing channel', type: 'enum', options: BUSINESS_READY_UPDATE_TYPES },
  { key: 'deliveryOptimizationMode', label: 'Delivery optimization mode', type: 'enum', options: DELIVERY_OPTIMIZATION_MODES },
  { key: 'deadlineForQualityUpdatesInDays', label: 'Quality update deadline (days)', type: 'number', min: 0, max: 30 },
  { key: 'deadlineForFeatureUpdatesInDays', label: 'Feature update deadline (days)', type: 'number', min: 0, max: 30 },
  { key: 'deadlineGracePeriodInDays', label: 'Deadline grace period (days)', type: 'number', min: 0, max: 7 },
  { key: 'allowWindows11Upgrade', label: 'Allow Windows 11 upgrade', type: 'boolean' },
]

export interface UpdateRingSpec {
  sectionName: string
  name: string
  description: string
  /** Only the writable Graph fields the user set, keyed by Graph property. */
  graph: Record<string, unknown>
  assignments: AssignmentSpec
}

/** The ring name is the reconciliation key. */
export function ringKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field; undefined when blank/non-numeric (so it is left unmanaged). */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a checkbox field; undefined when unset. */
function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no' || v === '') return false
  }
  return undefined
}

/** True when at least one assignment target is declared (drives assign convergence). */
export function hasAnyAssignment(spec: AssignmentSpec): boolean {
  return spec.includeGroupIds.length > 0 || spec.excludeGroupIds.length > 0 || Boolean(spec.allDevices) || Boolean(spec.allUsers)
}

/** Each canvas item is one update ring: name + the writable ring fields + assignments. */
export function extractRingSpecs(canvas: CanvasSnapshot): UpdateRingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const graph: Record<string, unknown> = {}
    for (const def of RING_FIELDS) {
      const raw = fields[def.key]
      if (def.type === 'number') {
        const n = readNumber(raw)
        if (n !== undefined) graph[def.key] = n
      } else if (def.type === 'boolean') {
        const b = readBool(raw)
        if (b !== undefined) graph[def.key] = b
      } else if (typeof raw === 'string' && raw.trim() !== '') {
        graph[def.key] = raw.trim()
      }
    }
    return {
      sectionName: section.name,
      name: typeof fields.ring_name === 'string' ? fields.ring_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      graph,
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices) ?? false,
        allUsers: readBool(fields.allUsers) ?? false,
      },
    }
  })
}

/** Build the create/PATCH body — the @odata.type subtype is required on both. */
export function buildRingBody(spec: UpdateRingSpec): Record<string, unknown> {
  return {
    '@odata.type': WINDOWS_UPDATE_RING_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    ...spec.graph,
  }
}

/**
 * Validate update rings: each needs a unique name and every managed number field
 * within its Graph range; enum selects must carry a known value. A ring with no
 * assignment target is warned (it would apply to no devices).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no update ring items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.ring_name`, message: 'Ring name is required', code: 'required' })
    } else {
      const key = ringKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.ring_name`, message: `Duplicate ring name "${spec.name}"`, code: 'duplicate_ring' })
      }
      seen.add(key)
    }

    for (const def of RING_FIELDS) {
      if (!(def.key in spec.graph)) continue
      const value = spec.graph[def.key]
      if (def.type === 'number' && typeof value === 'number') {
        if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
          errors.push({
            field: `${prefix}.${def.key}`,
            message: `${def.label} must be between ${def.min} and ${def.max}`,
            code: 'out_of_range',
          })
        }
      } else if (def.type === 'enum' && def.options && typeof value === 'string' && !def.options.includes(value)) {
        errors.push({
          field: `${prefix}.${def.key}`,
          message: `${def.label} "${value}" is not a valid value`,
          code: 'invalid_enum',
        })
      }
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Ring has no assignment — add include groups or target all devices/users, or it will apply to nothing',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
