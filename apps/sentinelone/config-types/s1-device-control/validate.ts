import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne Device Control constraints -----------------------------------
// Source: SentinelOne Management API v2.1 `/device-control` (USB and Bluetooth
// peripheral control). Field enums below are taken from the collection's own
// list-filter parameters (accessPermissions, actions, interfaces, statuses),
// which this API consistently names after the object's own fields (singular in
// the write body, plural as the list filter) — the same inference this app
// already relies on for exclusions/restrictions/STAR rules. See
// config-types/s1-device-control/deploy.ts for the cited sources.

export const INTERFACES = ['USB', 'Bluetooth'] as const
export const ACTIONS = ['Allow', 'Block'] as const
export const ACCESS_PERMISSIONS = ['Not-Applicable', 'Read-Only', 'Read-Write'] as const
export const STATUSES = ['Enabled', 'Disabled'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DeviceRuleSpec {
  sectionName: string
  ruleName: string
  interfaceType: string
  action: string
  accessPermission: string
  deviceClass?: string
  vendorId?: string
  productId?: string
  serialId?: string
  bluetoothAddress?: string
  status: string
}

/** Shape of a rule returned by GET /device-control. */
export interface LiveDeviceRule {
  id?: string
  ruleName?: string
  interface?: string
  action?: string
  accessPermission?: string
  deviceClass?: string
  vendorId?: string
  productId?: string
  uid?: string
  bluetoothAddress?: string
  status?: string
}

/**
 * The rule's logical identity at a scope: its name. Case-insensitive and
 * trimmed, matching how this app already reconciles SentinelOne STAR rules and
 * Firewall Control rules (rule names are not enforced-unique server-side, so
 * this app enforces it client-side for a stable natural key).
 */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one SentinelOne Device Control rule. */
export function extractDeviceRuleSpecs(canvas: CanvasSnapshot): DeviceRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const optStr = (value: unknown): string | undefined => str(value) || undefined
    return {
      sectionName: section.name,
      ruleName: str(fields.rule_name),
      interfaceType: str(fields.interface) || 'USB',
      action: str(fields.action) || 'Block',
      accessPermission: str(fields.access_permission) || 'Not-Applicable',
      deviceClass: optStr(fields.device_class),
      vendorId: optStr(fields.vendor_id),
      productId: optStr(fields.product_id),
      serialId: optStr(fields.serial_id),
      bluetoothAddress: optStr(fields.bluetooth_address),
      status: str(fields.status) || 'Enabled',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Device Control rule configurations against SentinelOne constraints:
 * a rule name is required; interface, action, access permission and status must
 * be from the supported sets; USB-only fields are warned about on a Bluetooth
 * rule and vice versa; and the rule name (case-insensitive) must be unique
 * across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDeviceRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    }
    if (!INTERFACES.includes(spec.interfaceType as (typeof INTERFACES)[number])) {
      errors.push({ field: `${prefix}.interface`, message: `Unsupported interface "${spec.interfaceType}"`, code: 'invalid_interface' })
    }
    if (!ACTIONS.includes(spec.action as (typeof ACTIONS)[number])) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!ACCESS_PERMISSIONS.includes(spec.accessPermission as (typeof ACCESS_PERMISSIONS)[number])) {
      errors.push({
        field: `${prefix}.access_permission`,
        message: `Unsupported access permission "${spec.accessPermission}"`,
        code: 'invalid_access_permission',
      })
    }
    if (!STATUSES.includes(spec.status as (typeof STATUSES)[number])) {
      errors.push({ field: `${prefix}.status`, message: `Unsupported status "${spec.status}"`, code: 'invalid_status' })
    }

    if (spec.interfaceType === 'USB' && spec.bluetoothAddress) {
      warnings.push({
        field: `${prefix}.bluetooth_address`,
        message: 'Bluetooth Address is set on a USB rule and will be ignored',
        code: 'irrelevant_field',
      })
    }
    if (spec.interfaceType === 'Bluetooth' && (spec.vendorId || spec.productId || spec.serialId)) {
      warnings.push({
        field: `${prefix}.vendor_id`,
        message: 'Vendor ID / Product ID / Serial ID are USB-only fields and will be ignored on a Bluetooth rule',
        code: 'irrelevant_field',
      })
    }

    if (spec.ruleName) {
      const key = ruleKey(spec.ruleName)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule "${spec.ruleName}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
