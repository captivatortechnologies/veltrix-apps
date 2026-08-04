import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Jamf Pro Computer Extension Attributes.
//
// RESEARCH NOTE / DEVIATION: the wave-3 brief suggested the Classic API
// (`/JSSResource/computerextensionattributes`), but that endpoint's own docs
// state "The Jamf Pro API offers full parity for this resource. We recommend
// using the Jamf Pro API for new integrations" — and the modern
// `/v1/computer-extension-attributes` (GET/POST/PUT/DELETE) does have full
// CRUD parity with a clean JSON schema. This config type therefore uses the
// MODERN API instead, via `JamfClient.request` (`lib/jamfApi.ts`), matching
// Jamf's own guidance rather than the Classic (XML) path everything else in
// this wave uses. See:
// https://developer.jamf.com/jamf-pro/reference/get_v1-computer-extension-attributes
// https://developer.jamf.com/jamf-pro/reference/post_v1-computer-extension-attributes
// https://developer.jamf.com/jamf-pro/reference/put_v1-computer-extension-attributes-id
// https://developer.jamf.com/jamf-pro/reference/delete_v1-computer-extension-attributes-id
// =============================================================================

export const DATA_TYPES = ['STRING', 'INTEGER', 'DATE'] as const
export const INPUT_TYPES = ['SCRIPT', 'TEXT', 'POPUP', 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING'] as const
export const INVENTORY_DISPLAY_TYPES = [
  'GENERAL',
  'HARDWARE',
  'OPERATING_SYSTEM',
  'USER_AND_LOCATION',
  'PURCHASING',
  'EXTENSION_ATTRIBUTES',
] as const
export const MANAGE_EXISTING_DATA_OPTIONS = ['RETAIN', 'DELETE'] as const

export interface ExtensionAttributeSpec {
  sectionName: string
  name: string
  description: string
  dataType: string
  inputType: string
  inventoryDisplayType: string
  enabled: boolean
  scriptContents: string
  popupMenuChoices: string[]
  ldapAttributeMapping: string
  ldapExtensionAttributeAllowed: boolean
  manageExistingData: string
}

/** Shape of a Jamf Pro ComputerExtensionAttribute object, as returned by list/create/update. */
export interface LiveExtensionAttribute {
  id?: string
  name?: string
  description?: string
  dataType?: string
  inputType?: string
  inventoryDisplayType?: string
  enabled?: boolean
  scriptContents?: string | null
  popupMenuChoices?: string[] | null
  ldapAttributeMapping?: string | null
  ldapExtensionAttributeAllowed?: boolean
  manageExistingData?: string | null
}

export function extensionAttributeKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexExtensionAttributesByName(attrs: LiveExtensionAttribute[]): Map<string, LiveExtensionAttribute> {
  const byName = new Map<string, LiveExtensionAttribute>()
  for (const a of attrs) {
    if (!a.name) continue
    const key = extensionAttributeKey(a.name)
    if (!byName.has(key)) byName.set(key, a)
  }
  return byName
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractExtensionAttributeSpecs(canvas: CanvasSnapshot): ExtensionAttributeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      dataType: str(fields.data_type) || 'STRING',
      inputType: str(fields.input_type) || 'TEXT',
      inventoryDisplayType: str(fields.inventory_display_type) || 'EXTENSION_ATTRIBUTES',
      enabled: readBool(fields.enabled, true),
      scriptContents: typeof fields.script_contents === 'string' ? fields.script_contents : '',
      popupMenuChoices: strList(fields.popup_menu_choices),
      ldapAttributeMapping: str(fields.ldap_attribute_mapping),
      ldapExtensionAttributeAllowed: readBool(fields.ldap_extension_attribute_allowed, false),
      manageExistingData: str(fields.manage_existing_data),
    }
  })
}

/** The `ComputerExtensionAttributes` request body the create/update endpoints accept for a spec. */
export function buildExtensionAttributeBody(spec: ExtensionAttributeSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    dataType: spec.dataType,
    inputType: spec.inputType,
    inventoryDisplayType: spec.inventoryDisplayType,
    enabled: spec.enabled,
  }
  if (spec.inputType === 'SCRIPT') body.scriptContents = spec.scriptContents
  if (spec.inputType === 'POPUP') body.popupMenuChoices = spec.popupMenuChoices
  if (spec.inputType === 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING') {
    body.ldapAttributeMapping = spec.ldapAttributeMapping
    body.ldapExtensionAttributeAllowed = spec.ldapExtensionAttributeAllowed
  }
  if (spec.manageExistingData) body.manageExistingData = spec.manageExistingData
  return body
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate computer extension attribute configurations: name required +
 * unique; dataType/inputType/inventoryDisplayType must be supported values;
 * scriptContents required when inputType is SCRIPT; at least one
 * popupMenuChoice required when inputType is POPUP; ldapAttributeMapping
 * required when inputType is DIRECTORY_SERVICE_ATTRIBUTE_MAPPING.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractExtensionAttributeSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Extension attribute name is required', code: 'required' })
    }
    if (!DATA_TYPES.includes(spec.dataType as (typeof DATA_TYPES)[number])) {
      errors.push({ field: `${prefix}.data_type`, message: `Unsupported data type "${spec.dataType}"`, code: 'invalid_data_type' })
    }
    if (!INPUT_TYPES.includes(spec.inputType as (typeof INPUT_TYPES)[number])) {
      errors.push({ field: `${prefix}.input_type`, message: `Unsupported input type "${spec.inputType}"`, code: 'invalid_input_type' })
    }
    if (!INVENTORY_DISPLAY_TYPES.includes(spec.inventoryDisplayType as (typeof INVENTORY_DISPLAY_TYPES)[number])) {
      errors.push({
        field: `${prefix}.inventory_display_type`,
        message: `Unsupported inventory display type "${spec.inventoryDisplayType}"`,
        code: 'invalid_inventory_display_type',
      })
    }

    if (spec.inputType === 'SCRIPT' && !spec.scriptContents) {
      errors.push({ field: `${prefix}.script_contents`, message: 'Script contents are required when input type is Script', code: 'required' })
    }
    if (spec.inputType === 'POPUP' && spec.popupMenuChoices.length === 0) {
      errors.push({ field: `${prefix}.popup_menu_choices`, message: 'At least one choice is required when input type is Pop-up Menu', code: 'required' })
    }
    if (spec.inputType === 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING' && !spec.ldapAttributeMapping) {
      errors.push({
        field: `${prefix}.ldap_attribute_mapping`,
        message: 'An LDAP attribute mapping is required when input type is Directory Service Attribute Mapping',
        code: 'required',
      })
    }
    if (
      spec.manageExistingData &&
      !MANAGE_EXISTING_DATA_OPTIONS.includes(spec.manageExistingData as (typeof MANAGE_EXISTING_DATA_OPTIONS)[number])
    ) {
      errors.push({
        field: `${prefix}.manage_existing_data`,
        message: `Unsupported manage-existing-data option "${spec.manageExistingData}"`,
        code: 'invalid_manage_existing_data',
      })
    }

    if (spec.name) {
      const key = extensionAttributeKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate extension attribute "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_extension_attribute',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
