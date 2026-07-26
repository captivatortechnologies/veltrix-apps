import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Microsoft first-party, tenant-based data-connector kinds that the
 * Microsoft.SecurityInsights/dataConnectors API can create/update with a simple
 * { tenantId, dataTypes:{...state} } body. CCP / codeless / AWS / threat-intel
 * kinds have distinct schemas or are portal-only and are out of scope.
 */
export const DATA_CONNECTOR_KINDS = [
  'AzureActiveDirectory',
  'AzureAdvancedThreatProtection',
  'MicrosoftDefenderAdvancedThreatProtection',
  'MicrosoftCloudAppSecurity',
  'Office365',
] as const
export type DataConnectorKind = (typeof DATA_CONNECTOR_KINDS)[number]

/** Data connector ids become the ARM resource name — keep them URL-safe. */
export const CONNECTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** A GUID (tenant id) shape. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The data types each kind exposes: the canvas toggle → the API dataTypes key. */
const KIND_DATA_TYPES: Record<string, Array<{ fieldKey: string; apiKey: string; fallback: boolean }>> = {
  AzureActiveDirectory: [{ fieldKey: 'enable_alerts', apiKey: 'alerts', fallback: true }],
  AzureAdvancedThreatProtection: [{ fieldKey: 'enable_alerts', apiKey: 'alerts', fallback: true }],
  MicrosoftDefenderAdvancedThreatProtection: [{ fieldKey: 'enable_alerts', apiKey: 'alerts', fallback: true }],
  MicrosoftCloudAppSecurity: [
    { fieldKey: 'enable_alerts', apiKey: 'alerts', fallback: true },
    { fieldKey: 'enable_discovery_logs', apiKey: 'discoveryLogs', fallback: false },
  ],
  Office365: [
    { fieldKey: 'enable_exchange', apiKey: 'exchange', fallback: true },
    { fieldKey: 'enable_sharepoint', apiKey: 'sharePoint', fallback: true },
    { fieldKey: 'enable_teams', apiKey: 'teams', fallback: true },
  ],
}

/** One data connector authored on the canvas. */
export interface DataConnectorSpec {
  sectionName: string
  /** The ARM dataConnectorId (the identity). */
  connectorId: string
  kind: string
  tenantId: string
  /** dataTypes keyed by the API dataType key (alerts, discoveryLogs, exchange, ...) → enabled. */
  dataTypes: Record<string, boolean>
}

/** The reconciliation key is the connector id (lower-cased for matching). */
export function connectorKey(connectorId: string): string {
  return connectorId.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Map a spec's enabled data types to the API state map ({ alerts: 'Enabled', ... }). */
export function connectorDataTypeStates(spec: DataConnectorSpec): Record<string, 'Enabled' | 'Disabled'> {
  const out: Record<string, 'Enabled' | 'Disabled'> = {}
  for (const [apiKey, enabled] of Object.entries(spec.dataTypes)) out[apiKey] = enabled ? 'Enabled' : 'Disabled'
  return out
}

/** Each canvas item is one data connector. */
export function extractDataConnectorSpecs(canvas: CanvasSnapshot): DataConnectorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const kind = typeof fields.kind === 'string' && fields.kind.trim() ? fields.kind.trim() : 'AzureActiveDirectory'
    const descriptors = KIND_DATA_TYPES[kind] ?? []
    const dataTypes: Record<string, boolean> = {}
    for (const d of descriptors) dataTypes[d.apiKey] = readBool(fields[d.fieldKey], d.fallback)
    return {
      sectionName: section.name,
      connectorId: typeof fields.connector_id === 'string' ? fields.connector_id.trim() : '',
      kind,
      tenantId: typeof fields.tenant_id === 'string' ? fields.tenant_id.trim() : '',
      dataTypes,
    }
  })
}

/**
 * Validate data connectors. Each needs a URL-safe unique connector id, a
 * supported kind, a source tenant GUID, and at least one data type enabled.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no data connectors', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractDataConnectorSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.connectorId) {
      errors.push({ field: `${prefix}.connector_id`, message: 'Connector ID is required', code: 'required' })
    } else {
      if (!CONNECTOR_ID_RE.test(spec.connectorId)) {
        errors.push({
          field: `${prefix}.connector_id`,
          message: `Connector ID "${spec.connectorId}" must start with a letter/number and contain only letters, numbers, hyphens or underscores`,
          code: 'invalid_connector_id',
        })
      }
      const key = connectorKey(spec.connectorId)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.connector_id`, message: `Duplicate connector ID "${spec.connectorId}"`, code: 'duplicate_connector' })
      }
      seen.add(key)
    }

    if (!DATA_CONNECTOR_KINDS.includes(spec.kind as DataConnectorKind)) {
      errors.push({ field: `${prefix}.kind`, message: `Connector kind must be one of ${DATA_CONNECTOR_KINDS.join(', ')}`, code: 'invalid_kind' })
    }

    if (!spec.tenantId) {
      errors.push({ field: `${prefix}.tenant_id`, message: 'Source tenant ID is required', code: 'required' })
    } else if (!GUID_RE.test(spec.tenantId)) {
      errors.push({ field: `${prefix}.tenant_id`, message: 'Source tenant ID must be a GUID', code: 'invalid_tenant' })
    }

    const states = connectorDataTypeStates(spec)
    if (Object.keys(states).length > 0 && !Object.values(states).some((s) => s === 'Enabled')) {
      errors.push({
        field: `${prefix}.enable_alerts`,
        message: 'Enable at least one data type for the connector',
        code: 'no_data_type',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
