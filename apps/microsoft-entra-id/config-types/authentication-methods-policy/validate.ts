import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra authentication-methods-policy constraints -------------------------
//
// Scope: this type manages the ENABLEMENT (state) of each built-in authentication
// method. Method configurations are fixed system singletons (no create/delete),
// so deploy PATCHes only the method's `state` (and the required @odata.type
// discriminator); other per-method settings and targets are left untouched.

/** The fixed set of method ids → their @odata.type discriminator. */
export const METHOD_ODATA_TYPES: Record<string, string> = {
  fido2: '#microsoft.graph.fido2AuthenticationMethodConfiguration',
  microsoftAuthenticator: '#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration',
  sms: '#microsoft.graph.smsAuthenticationMethodConfiguration',
  temporaryAccessPass: '#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration',
  email: '#microsoft.graph.emailAuthenticationMethodConfiguration',
  x509Certificate: '#microsoft.graph.x509CertificateAuthenticationMethodConfiguration',
  softwareOath: '#microsoft.graph.softwareOathAuthenticationMethodConfiguration',
  voice: '#microsoft.graph.voiceAuthenticationMethodConfiguration',
  hardwareOath: '#microsoft.graph.hardwareOathAuthenticationMethodConfiguration',
}

export const METHOD_STATES = new Set(['enabled', 'disabled'])

export interface AuthMethodSpec {
  itemId?: string
  /** The method id (fixed set) — the logical identity and Graph resource id. */
  method: string
  state: string
}

/** An authentication method configuration as returned by Graph. */
export interface LiveAuthMethodConfig {
  id?: string
  state?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAuthMethodSpecs(canvas: CanvasSnapshot): AuthMethodSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      method: asString(f.method),
      state: asString(f.state) || 'disabled',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAuthMethodSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.method) {
      errors.push({ field: `${prefix}.method`, message: 'Method is required', code: 'required' })
    } else {
      if (!(spec.method in METHOD_ODATA_TYPES)) {
        errors.push({
          field: `${prefix}.method`,
          message: `Method "${spec.method}" is not one of ${Object.keys(METHOD_ODATA_TYPES).join(', ')}`,
          code: 'invalid_method',
        })
      }
      if (seen.has(spec.method)) {
        errors.push({
          field: `${prefix}.method`,
          message: `Duplicate method "${spec.method}" — each may only be declared once per canvas`,
          code: 'duplicate_method',
        })
      }
      seen.add(spec.method)
    }

    if (!METHOD_STATES.has(spec.state)) {
      errors.push({
        field: `${prefix}.state`,
        message: 'State must be either "enabled" or "disabled"',
        code: 'invalid_state',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
