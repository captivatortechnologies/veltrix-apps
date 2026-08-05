import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, barracudaErrorMessage, readString, type BarracudaWaasClient } from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service Basic Security constraints -------------------
//
// Application-wide singleton, a dedicated GET/PATCH/PUT sub-resource of the
// Application: /applications/{appName}/basic_security/ { protection_mode }.
// `protection_mode` is a two-value enum confirmed directly against the live
// API schema (api.waas.barracudanetworks.com/v4/swagger/, schema
// BasicSecurity: protection_mode enum [Passive, Active]).

const VALID_MODES = new Set(['Active', 'Passive'])

export interface BasicSecuritySpec {
  protectionMode: string
}

/** The singleton item's field, or the field default when no item is declared. */
export function extractBasicSecuritySpec(canvas: CanvasSnapshot): BasicSecuritySpec {
  const fields = (canvas.sections ?? [])[0]?.fields ?? {}
  const mode = readString(fields.protection_mode)
  return { protectionMode: mode || 'Passive' }
}

export interface LiveBasicSecurity {
  protection_mode?: string
}

/** Read the Application's current Basic Security object; throws on a non-OK response. */
export async function getBasicSecurity(client: BarracudaWaasClient, appName: string): Promise<LiveBasicSecurity> {
  const res = await client.request('GET', `${client.appPath(appName)}/basic_security/`)
  if (!res.ok) throw new Error(`Failed to read Basic Security: ${barracudaErrorMessage(res)}`)
  return asObject(res.body) as LiveBasicSecurity
}

/** Build the PUT/PATCH body from a declared spec. */
export function buildBasicSecurityBody(spec: BasicSecuritySpec): LiveBasicSecurity {
  return { protection_mode: spec.protectionMode }
}

// --- Validate handler ---------------------------------------------------------

/** Validate the Basic Security singleton: at most one declared item, and a recognized protection_mode. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Add the Basic Security item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({ field: 'sections', message: 'Basic Security is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  const spec = extractBasicSecuritySpec(ctx.canvas)
  const prefix = sections[0].name

  if (!VALID_MODES.has(spec.protectionMode)) {
    errors.push({
      field: `${prefix}.protection_mode`,
      message: `Protection mode must be "Active" or "Passive" (got "${spec.protectionMode}")`,
      code: 'invalid_mode',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
