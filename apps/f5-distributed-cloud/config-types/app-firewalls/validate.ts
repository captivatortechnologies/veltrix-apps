import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/f5xc'

// --- F5 XC App Firewall API constraints ---------------------------------------
// https://docs.cloud.f5.com/docs-v2/api/app-firewall
//
// GET/POST       /config/namespaces/{namespace}/app_firewalls         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/app_firewalls/{name}  - read / update / delete
//
// Custom per-signature/per-violation detection tuning
// (detection_settings.violations_view is a REQUIRED list once detection_settings
// is chosen, sourced from F5's live violation catalog) and custom
// header/cookie/query anonymization lists are intentionally not modeled here
// - see README.md Coverage.

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type EnforcementMode = 'blocking' | 'monitoring' | 'use_loadbalancer_setting'
export type ResponseCodesMode = 'allow_all_response_codes' | 'allowed_response_codes'
export type BlockingPageMode = 'use_default_blocking_page' | 'blocking_page'

export interface AppFirewallSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  enforcementMode: EnforcementMode
  enableBotProtection: boolean
  responseCodesMode: ResponseCodesMode
  allowedResponseCodes: number[]
  blockingPageMode: BlockingPageMode
  customBlockingPageHtml?: string
  customBlockingResponseCode?: string
}

/** Shape of an app_firewall spec returned by GET .../app_firewalls/{name}. */
export interface LiveAppFirewallSpec {
  allow_all_response_codes?: boolean
  allowed_response_codes?: { response_code?: number[] }
  default_anonymization?: boolean
  blocking_page?: { blocking_page?: string; response_code?: string }
  use_default_blocking_page?: boolean
  default_bot_setting?: boolean
  default_detection_settings?: boolean
  blocking?: boolean
  monitoring?: boolean
  use_loadbalancer_setting?: boolean
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one F5 XC App Firewall (WAF) policy. */
export function extractAppFirewallSpecs(canvas: CanvasSnapshot): AppFirewallSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const enforcementMode: EnforcementMode =
      fields.enforcementMode === 'monitoring' || fields.enforcementMode === 'use_loadbalancer_setting'
        ? fields.enforcementMode
        : 'blocking'
    const responseCodesMode: ResponseCodesMode =
      fields.responseCodesMode === 'allowed_response_codes' ? 'allowed_response_codes' : 'allow_all_response_codes'
    const blockingPageMode: BlockingPageMode =
      fields.blockingPageMode === 'blocking_page' ? 'blocking_page' : 'use_default_blocking_page'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      enforcementMode,
      enableBotProtection: fields.enableBotProtection !== false,
      responseCodesMode,
      allowedResponseCodes: splitList(fields.allowedResponseCodes)
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v)),
      blockingPageMode,
      customBlockingPageHtml: toText(fields.customBlockingPageHtml),
      customBlockingResponseCode: toText(fields.customBlockingResponseCode),
    }
  })
}

/**
 * Validate App Firewall configurations against the F5 XC API. Static only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - when responseCodesMode is "allowed_response_codes", at least one code is required
 *   - when blockingPageMode is "blocking_page", custom HTML is required
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppFirewallSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'App Firewall name is required', code: 'required' })
      continue
    }
    if (!NAME_PATTERN.test(spec.name) || spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Name must be a DNS-1035 label: lowercase alphanumeric and hyphens, starting with a letter, 63 characters or fewer',
        code: 'invalid_name',
      })
    }
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate App Firewall "${spec.name}" - each policy may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.responseCodesMode === 'allowed_response_codes' && spec.allowedResponseCodes.length === 0) {
      errors.push({
        field: `${prefix}.allowedResponseCodes`,
        message: 'At least one allowed status code is required when restricting response codes',
        code: 'required',
      })
    }

    if (spec.blockingPageMode === 'blocking_page' && !spec.customBlockingPageHtml) {
      errors.push({
        field: `${prefix}.customBlockingPageHtml`,
        message: 'Custom blocking page HTML is required when using a custom blocking page',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
