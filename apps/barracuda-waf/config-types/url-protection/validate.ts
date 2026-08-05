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

// --- Barracuda WAF-as-a-Service URL Protection constraints -------------------
//
// Application-wide singleton, a dedicated GET/PATCH/PUT sub-resource of the
// Application: /applications/{appName}/url_protection/. Every field name
// below (enabled, allowed_methods, allowed_content_types,
// max_content_length, max_parameters, maximum_upload_files,
// csrf_prevention, maximum_parameter_name_length, allow_tilde_in_url,
// allow_slash_dot_in_url, exception_patterns, plus the shared attack-type
// fields) is confirmed directly against the live API schema
// (api.waas.barracudanetworks.com/v4/swagger/, schema
// UrlProtectionResponseSchema). `csrf_prevention`'s exact 3-value enum
// (None/Forms/All) is corroborated by Barracuda's on-premises WAF Admin
// Reference Guide's identical "CSRF Prevention" attribute.

const VALID_CSRF_MODES = new Set(['None', 'Forms', 'All'])

export interface UrlProtectionSpec {
  enabled: boolean
  allowedMethods: string[]
  allowedContentTypes: string[]
  maxContentLength: number
  maxParameters: number
  maximumUploadFiles: number
  csrfPrevention: string
  maximumParameterNameLength: number
  allowTildeInUrl: boolean
  allowSlashDotInUrl: boolean
  exceptionPatterns: string[]
  attackTypes: AttackTypeSettings
}

/** The singleton item's fields, or field defaults when no item is declared. */
export function extractUrlProtectionSpec(canvas: CanvasSnapshot): UrlProtectionSpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}

  return {
    enabled: readBool(fields.enabled, false),
    allowedMethods: readStringList(fields.allowed_methods),
    allowedContentTypes: readStringList(fields.allowed_content_types),
    maxContentLength: readNumber(fields.max_content_length, 32768),
    maxParameters: readNumber(fields.max_parameters, 40),
    maximumUploadFiles: readNumber(fields.maximum_upload_files, 5),
    csrfPrevention: readString(fields.csrf_prevention) || 'Forms',
    maximumParameterNameLength: readNumber(fields.maximum_parameter_name_length, 64),
    allowTildeInUrl: readBool(fields.allow_tilde_in_url, false),
    allowSlashDotInUrl: readBool(fields.allow_slash_dot_in_url, false),
    exceptionPatterns: readStringList(fields.exception_patterns),
    attackTypes: readAttackTypeSettings(fields),
  }
}

export interface LiveUrlProtection {
  enabled?: boolean
  allowed_methods?: string[]
  allowed_content_types?: string[]
  max_content_length?: number
  max_parameters?: number
  maximum_upload_files?: number
  csrf_prevention?: string
  maximum_parameter_name_length?: number
  allow_tilde_in_url?: boolean
  allow_slash_dot_in_url?: boolean
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

/** Read the Application's current URL Protection object; throws on a non-OK response. */
export async function getUrlProtection(client: BarracudaWaasClient, appName: string): Promise<LiveUrlProtection> {
  const res = await client.request('GET', `${client.appPath(appName)}/url_protection/`)
  if (!res.ok) throw new Error(`Failed to read URL Protection: ${barracudaErrorMessage(res)}`)
  return asObject(res.body) as LiveUrlProtection
}

/** Build the PUT/PATCH body from a declared spec. */
export function buildUrlProtectionBody(spec: UrlProtectionSpec): LiveUrlProtection {
  return {
    enabled: spec.enabled,
    allowed_methods: spec.allowedMethods,
    allowed_content_types: spec.allowedContentTypes,
    max_content_length: spec.maxContentLength,
    max_parameters: spec.maxParameters,
    maximum_upload_files: spec.maximumUploadFiles,
    csrf_prevention: spec.csrfPrevention,
    maximum_parameter_name_length: spec.maximumParameterNameLength,
    allow_tilde_in_url: spec.allowTildeInUrl,
    allow_slash_dot_in_url: spec.allowSlashDotInUrl,
    exception_patterns: spec.exceptionPatterns,
    ...buildAttackTypeBody(spec.attackTypes),
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the URL Protection singleton: at most one declared item;
 * `csrf_prevention` must be one of None/Forms/All; request-size/count limits
 * must be positive integers.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the URL Protection item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({ field: 'sections', message: 'URL Protection is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  const spec = extractUrlProtectionSpec(ctx.canvas)
  const prefix = sections[0].name

  if (!VALID_CSRF_MODES.has(spec.csrfPrevention)) {
    errors.push({
      field: `${prefix}.csrf_prevention`,
      message: `CSRF Prevention must be "None", "Forms", or "All" (got "${spec.csrfPrevention}")`,
      code: 'invalid_csrf_mode',
    })
  }

  if (!Number.isInteger(spec.maxContentLength) || spec.maxContentLength <= 0) {
    errors.push({
      field: `${prefix}.max_content_length`,
      message: `Max Content Length must be a positive integer, in bytes (got ${spec.maxContentLength})`,
      code: 'invalid_content_length',
    })
  }

  if (!Number.isInteger(spec.maxParameters) || spec.maxParameters <= 0) {
    errors.push({
      field: `${prefix}.max_parameters`,
      message: `Max Parameters must be a positive integer (got ${spec.maxParameters})`,
      code: 'invalid_max_parameters',
    })
  }

  if (!Number.isInteger(spec.maximumUploadFiles) || spec.maximumUploadFiles <= 0) {
    errors.push({
      field: `${prefix}.maximum_upload_files`,
      message: `Maximum Upload Files must be a positive integer (got ${spec.maximumUploadFiles})`,
      code: 'invalid_upload_files',
    })
  }

  if (!Number.isInteger(spec.maximumParameterNameLength) || spec.maximumParameterNameLength <= 0) {
    errors.push({
      field: `${prefix}.maximum_parameter_name_length`,
      message: `Maximum Parameter Name Length must be a positive integer (got ${spec.maximumParameterNameLength})`,
      code: 'invalid_name_length',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
