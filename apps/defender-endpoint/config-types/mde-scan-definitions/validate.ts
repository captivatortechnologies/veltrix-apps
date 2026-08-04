// =============================================================================
// Defender Vulnerability Management AUTHENTICATED SCAN DEFINITIONS — spec model
// + validation.
//
// This config type manages authenticated (SNMP) network-device scan
// definitions via:
//   GET    /api/DeviceAuthenticatedScanDefinitions             — list
//   POST   /api/DeviceAuthenticatedScanDefinitions              — create
//   PATCH  /api/DeviceAuthenticatedScanDefinitions/{id}          — update
//   POST   /api/DeviceAuthenticatedScanDefinitions/BatchDelete   — delete
// (verified — needs the Machine.ReadWrite.All application permission, the SAME
// permission already required by machine-tags / device-values). Currently the
// only documented `scanType` is "Network" and the only documented
// authentication object is SNMP (`@odata.type`
// `#microsoft.windowsDefenderATP.api.SnmpAuthParams`) — this type models
// exactly that, not a hypothetical broader surface.
//
// `id` is SERVER-ASSIGNED on create (unlike indicators/detection-rules, which
// use a caller-chosen or natural key), so — like Cisco Meraki's group-policies
// type — this reconciles by a human-chosen natural key: `scanName`
// (case-insensitive, list -> match -> update or create).
//
// SECURITY: `scanAuthenticationParams` carries SNMP secrets (a community
// string, or a username + auth/priv passwords) OR an Azure Key Vault reference
// in place of them. It is treated as WRITE-ONLY end to end in this app — never
// read back, diffed, or persisted in rollbackData — for two reasons: (1) it is
// a credential, and (2) Microsoft's own docs are inconsistent about whether
// GET ever echoes it back at all (the "add"/"update" example responses show it
// null; the "list" example shows it populated). Given that inconsistency, this
// type never trusts a live value for it either way. It is re-sent, from the
// canvas, on every deploy — see deploy.ts.
//
// Self-contained like machine-tags / detection-rules / live-response-library:
// this module owns the spec model, and deploy/rollback/drift/health import
// from here. It reuses lib/mde.ts for the API client only.
// =============================================================================

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** The only documented scan type. */
export const SCAN_TYPE = 'Network' as const

/**
 * The two `targetType` values actually used in Microsoft's own request/response
 * JSON examples ("Ip" / "Hostname"). Docs prose elsewhere says "IP Address" /
 * "Hostname" — the JSON examples are treated as authoritative here since they
 * appear consistently across the add, update and list pages.
 */
export const TARGET_TYPES = ['Ip', 'Hostname'] as const
export type TargetType = (typeof TARGET_TYPES)[number]

/** How the scan definition points at its scanner-agent device. */
export const DEVICE_REF_TYPES = ['id', 'name'] as const
export type DeviceRefType = (typeof DEVICE_REF_TYPES)[number]

/** SNMP security levels — the `type` property of `SnmpAuthParams`. */
export const AUTH_MODES = ['CommunityString', 'NoAuthNoPriv', 'AuthNoPriv', 'AuthPriv'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

export const AUTH_PROTOCOLS = ['MD5', 'SHA1'] as const
export const PRIV_PROTOCOLS = ['DES', '3DES', 'AES'] as const

/** A Defender device id is a 40-character hex (SHA-1) string. */
const MACHINE_ID_PATTERN = /^[0-9a-fA-F]{40}$/

/** One declared scan definition, extracted from a canvas item. */
export interface ScanDefinitionSpec {
  sectionName: string
  scanName: string
  isActive: boolean
  intervalHours: number
  targetType: TargetType | ''
  targets: string[]
  scannerDeviceType: DeviceRefType
  scannerDevice: string
  authMode: AuthMode | ''
  useKeyVault: boolean
  keyVaultUrl: string
  keyVaultSecretName: string
  communityString: string
  username: string
  authProtocol: string
  authPassword: string
  privProtocol: string
  privPassword: string
}

/** A scan definition's NON-SECRET fields as returned by the list/get APIs. `scanAuthenticationParams` is deliberately not modeled here — see the module comment. */
export interface LiveScanDefinition {
  id?: string
  scanType?: string
  scanName?: string
  isActive?: boolean
  target?: string
  targetType?: string
  intervalInHours?: number
  createdBy?: string | null
  scannerAgent?: { machineId?: string; machineName?: string }
}

/** A machine as returned by GET /api/machines/{id} (the subset used to resolve the scanner agent). */
export interface LiveMachine {
  id?: string
  computerDnsName?: string
}

/** The case-insensitive scan-name key — a scan definition's identity. */
export function scanNameKey(scanName: string): string {
  return scanName.trim().toLowerCase()
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Read a targets/list field into a trimmed, non-empty string array (accepts a comma string too). */
function readList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v).trim()) : typeof value === 'string' ? value.split(',').map((v) => v.trim()) : []
  return raw.filter((v) => v.length > 0)
}

/** Each canvas item describes one scan definition. */
export function extractScanDefinitionSpecs(canvas: CanvasSnapshot): ScanDefinitionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawDeviceType = readString(fields.scanner_agent_device_type).toLowerCase()
    return {
      sectionName: section.name,
      scanName: readString(fields.scan_name),
      isActive: readBool(fields.is_active, true),
      intervalHours: readNumber(fields.interval_hours) ?? 24,
      targetType: (readString(fields.target_type) || 'Ip') as TargetType,
      targets: readList(fields.target),
      scannerDeviceType: rawDeviceType === 'name' ? 'name' : 'id',
      scannerDevice: readString(fields.scanner_agent_device),
      authMode: (readString(fields.auth_mode) || 'CommunityString') as AuthMode,
      useKeyVault: readBool(fields.use_key_vault, false),
      keyVaultUrl: readString(fields.keyvault_url),
      keyVaultSecretName: readString(fields.keyvault_secret_name),
      // Not trimmed — leading/trailing characters may be significant in a secret.
      communityString: typeof fields.community_string === 'string' ? fields.community_string : '',
      username: readString(fields.username),
      authProtocol: readString(fields.auth_protocol),
      authPassword: typeof fields.auth_password === 'string' ? fields.auth_password : '',
      privProtocol: readString(fields.priv_protocol),
      privPassword: typeof fields.priv_password === 'string' ? fields.priv_password : '',
    }
  })
}

/**
 * Build the SNMP `scanAuthenticationParams` object for one spec. Always
 * re-derived from the canvas — never from a live value (see the module
 * comment on why this is treated as write-only end to end).
 */
export function buildScanAuthParams(spec: ScanDefinitionSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    '@odata.type': '#microsoft.windowsDefenderATP.api.SnmpAuthParams',
    type: spec.authMode || 'CommunityString',
  }
  if (spec.useKeyVault) {
    params.KeyVaultUrl = spec.keyVaultUrl
    params.KeyVaultSecretName = spec.keyVaultSecretName
    return params
  }
  if (spec.authMode === 'CommunityString') {
    params.CommunityString = spec.communityString
    return params
  }
  params.Username = spec.username
  if (spec.authMode === 'AuthNoPriv' || spec.authMode === 'AuthPriv') {
    params.AuthProtocol = spec.authProtocol
    params.AuthPassword = spec.authPassword
  }
  if (spec.authMode === 'AuthPriv') {
    params.PrivProtocol = spec.privProtocol
    params.PrivPassword = spec.privPassword
  }
  return params
}

/** Build the non-secret POST/PATCH body fields shared by create and update. */
export function buildScanDefinitionBody(spec: ScanDefinitionSpec, scannerMachineId: string): Record<string, unknown> {
  return {
    scanType: SCAN_TYPE,
    scanName: spec.scanName,
    isActive: spec.isActive,
    target: spec.targets.join(','),
    targetType: spec.targetType || 'Ip',
    intervalInHours: spec.intervalHours,
    scannerAgent: { machineId: scannerMachineId },
    scanAuthenticationParams: buildScanAuthParams(spec),
  }
}

/**
 * Validate declared scan definitions: a name, at least one target, a positive
 * integer interval, and a scanner device reference are required; the SNMP
 * credential fields required depend on `auth_mode` and whether Key Vault is
 * used; and the scan name is unique (case-insensitive) across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no scan definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScanDefinitionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.scanName) errors.push({ field: `${prefix}.scan_name`, message: 'Scan name is required', code: 'required' })

    if (spec.targets.length === 0) {
      errors.push({ field: `${prefix}.target`, message: 'At least one target (IP address or hostname) is required', code: 'required' })
    }
    if (!TARGET_TYPES.includes(spec.targetType as TargetType)) {
      errors.push({ field: `${prefix}.target_type`, message: `Unsupported target type "${spec.targetType}"`, code: 'invalid_target_type' })
    }

    if (!Number.isInteger(spec.intervalHours) || spec.intervalHours <= 0) {
      errors.push({ field: `${prefix}.interval_hours`, message: 'Interval (hours) must be a positive whole number', code: 'invalid_interval' })
    }

    if (!spec.scannerDevice) {
      errors.push({ field: `${prefix}.scanner_agent_device`, message: 'Scanner device is required', code: 'required' })
    } else if (spec.scannerDeviceType === 'id' && !MACHINE_ID_PATTERN.test(spec.scannerDevice)) {
      errors.push({
        field: `${prefix}.scanner_agent_device`,
        message: 'Device ID must be a 40-character hex Defender device id (or reference the device by computer name)',
        code: 'invalid_device_id',
      })
    }

    if (!AUTH_MODES.includes(spec.authMode as AuthMode)) {
      errors.push({ field: `${prefix}.auth_mode`, message: `Unsupported SNMP security level "${spec.authMode}"`, code: 'invalid_auth_mode' })
    } else if (spec.useKeyVault) {
      if (!spec.keyVaultUrl) errors.push({ field: `${prefix}.keyvault_url`, message: 'Key Vault URL is required when Use Azure Key Vault is enabled', code: 'required' })
      if (!spec.keyVaultSecretName) errors.push({ field: `${prefix}.keyvault_secret_name`, message: 'Key Vault secret name is required when Use Azure Key Vault is enabled', code: 'required' })
    } else {
      if (spec.authMode === 'CommunityString' && !spec.communityString) {
        errors.push({ field: `${prefix}.community_string`, message: 'Community string is required for this SNMP security level', code: 'required' })
      }
      if (spec.authMode === 'NoAuthNoPriv' && !spec.username) {
        errors.push({ field: `${prefix}.username`, message: 'Username is required for this SNMP security level', code: 'required' })
      }
      if (spec.authMode === 'AuthNoPriv' || spec.authMode === 'AuthPriv') {
        if (!spec.username) errors.push({ field: `${prefix}.username`, message: 'Username is required for this SNMP security level', code: 'required' })
        if (!AUTH_PROTOCOLS.includes(spec.authProtocol as (typeof AUTH_PROTOCOLS)[number])) {
          errors.push({ field: `${prefix}.auth_protocol`, message: `Unsupported auth protocol "${spec.authProtocol}"`, code: 'invalid_auth_protocol' })
        }
        if (!spec.authPassword) errors.push({ field: `${prefix}.auth_password`, message: 'Auth password is required for this SNMP security level', code: 'required' })
      }
      if (spec.authMode === 'AuthPriv') {
        if (!PRIV_PROTOCOLS.includes(spec.privProtocol as (typeof PRIV_PROTOCOLS)[number])) {
          errors.push({ field: `${prefix}.priv_protocol`, message: `Unsupported privacy protocol "${spec.privProtocol}"`, code: 'invalid_priv_protocol' })
        }
        if (!spec.privPassword) errors.push({ field: `${prefix}.priv_password`, message: 'Privacy password is required for this SNMP security level', code: 'required' })
      }
    }

    if (spec.scanName) {
      const key = scanNameKey(spec.scanName)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.scan_name`, message: `Duplicate scan name "${spec.scanName}"`, code: 'duplicate_scan_name' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
