import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  asObject,
  barracudaErrorMessage,
  readBool,
  readNumber,
  readString,
  readStringList,
  type BarracudaWaasClient,
} from '../../lib/barracudaWaf'
import { buildAttackTypeBody, readAttackTypeSettings, type AttackTypeSettings } from '../lib/attackTypeSettings'

// --- Barracuda WAF-as-a-Service Parameter Protection constraints -------------
//
// Application-wide singleton, a dedicated GET/PATCH/PUT sub-resource of the
// Application: /applications/{appName}/parameter_protection/. Every field
// name below (enabled, denied_metacharacters,
// maximum_parameter_value_length, maximum_instances,
// base64_decode_parameter_value, validate_parameter_name,
// allowed_file_upload_types, file_upload_extensions, file_upload_mime_types,
// maximum_upload_file_size, ignore_parameters, exception_patterns, plus the
// shared attack-type fields) is confirmed directly against the live API
// schema (api.waas.barracudanetworks.com/v4/swagger/, schema
// ParameterProtection).

export interface ParameterProtectionSpec {
  enabled: boolean
  deniedMetacharacters: string
  maximumParameterValueLength: number
  maximumInstances: number
  base64DecodeParameterValue: boolean
  validateParameterName: boolean
  allowedFileUploadTypes: string
  fileUploadExtensions: string[]
  fileUploadMimeTypes: string[]
  maximumUploadFileSize: number
  ignoreParameters: string[]
  exceptionPatterns: string[]
  attackTypes: AttackTypeSettings
}

/** The singleton item's fields, or field defaults when no item is declared. */
export function extractParameterProtectionSpec(canvas: CanvasSnapshot): ParameterProtectionSpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}

  return {
    enabled: readBool(fields.enabled, false),
    deniedMetacharacters: readString(fields.denied_metacharacters),
    maximumParameterValueLength: readNumber(fields.maximum_parameter_value_length, 100),
    maximumInstances: readNumber(fields.maximum_instances, 1),
    base64DecodeParameterValue: readBool(fields.base64_decode_parameter_value, false),
    validateParameterName: readBool(fields.validate_parameter_name, false),
    allowedFileUploadTypes: readString(fields.allowed_file_upload_types) || 'all',
    fileUploadExtensions: readStringList(fields.file_upload_extensions),
    fileUploadMimeTypes: readStringList(fields.file_upload_mime_types),
    maximumUploadFileSize: readNumber(fields.maximum_upload_file_size, 1024),
    ignoreParameters: readStringList(fields.ignore_parameters),
    exceptionPatterns: readStringList(fields.exception_patterns),
    attackTypes: readAttackTypeSettings(fields),
  }
}

export interface LiveParameterProtection {
  enabled?: boolean
  denied_metacharacters?: string
  maximum_parameter_value_length?: number
  maximum_instances?: number
  base64_decode_parameter_value?: boolean
  validate_parameter_name?: boolean
  allowed_file_upload_types?: string
  file_upload_extensions?: string[]
  file_upload_mime_types?: string[]
  maximum_upload_file_size?: number
  ignore_parameters?: string[]
  exception_patterns?: string[]
  sql_injection?: string
  os_command_injection?: string
  cross_site_scripting?: string
  remote_file_inclusion?: string
  ldap_injection?: string
  python_php_attacks?: string
  http_specific_injection?: string
  apache_struts_attacks?: string
  directory_traversal?: string
  custom_blocked_attack_type_groups?: string[]
}

/** Read the Application's current Parameter Protection object; throws on a non-OK response. */
export async function getParameterProtection(client: BarracudaWaasClient, appName: string): Promise<LiveParameterProtection> {
  const res = await client.request('GET', `${client.appPath(appName)}/parameter_protection/`)
  if (!res.ok) throw new Error(`Failed to read Parameter Protection: ${barracudaErrorMessage(res)}`)
  return asObject(res.body) as LiveParameterProtection
}

/** Build the PUT/PATCH body from a declared spec. */
export function buildParameterProtectionBody(spec: ParameterProtectionSpec): LiveParameterProtection {
  return {
    enabled: spec.enabled,
    denied_metacharacters: spec.deniedMetacharacters,
    maximum_parameter_value_length: spec.maximumParameterValueLength,
    maximum_instances: spec.maximumInstances,
    base64_decode_parameter_value: spec.base64DecodeParameterValue,
    validate_parameter_name: spec.validateParameterName,
    allowed_file_upload_types: spec.allowedFileUploadTypes,
    file_upload_extensions: spec.fileUploadExtensions,
    file_upload_mime_types: spec.fileUploadMimeTypes,
    maximum_upload_file_size: spec.maximumUploadFileSize,
    ignore_parameters: spec.ignoreParameters,
    exception_patterns: spec.exceptionPatterns,
    ...buildAttackTypeBody(spec.attackTypes),
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the Parameter Protection singleton: at most one declared item;
 * length/instance/upload-size limits must be positive integers.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the Parameter Protection item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({ field: 'sections', message: 'Parameter Protection is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  const spec = extractParameterProtectionSpec(ctx.canvas)
  const prefix = sections[0].name

  if (!Number.isInteger(spec.maximumParameterValueLength) || spec.maximumParameterValueLength <= 0) {
    errors.push({
      field: `${prefix}.maximum_parameter_value_length`,
      message: `Maximum Parameter Value Length must be a positive integer (got ${spec.maximumParameterValueLength})`,
      code: 'invalid_length',
    })
  }

  if (!Number.isInteger(spec.maximumInstances) || spec.maximumInstances <= 0) {
    errors.push({
      field: `${prefix}.maximum_instances`,
      message: `Maximum Instances must be a positive integer (got ${spec.maximumInstances})`,
      code: 'invalid_instances',
    })
  }

  if (!Number.isInteger(spec.maximumUploadFileSize) || spec.maximumUploadFileSize <= 0) {
    errors.push({
      field: `${prefix}.maximum_upload_file_size`,
      message: `Maximum Upload File Size must be a positive integer, in KB (got ${spec.maximumUploadFileSize})`,
      code: 'invalid_upload_size',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
