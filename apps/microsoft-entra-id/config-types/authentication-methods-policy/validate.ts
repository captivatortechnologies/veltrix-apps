import { assertSafeProperties } from '../../lib/managedResources'
import { capabilityWarnings } from '../../lib/capabilityReview'
import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra authentication-methods-policy constraints -------------------------
//
// Method configurations are fixed system singletons. State is managed by default;
// optional configuration manages selected targeting and method-specific fields.
// Omitted settings remain unmanaged; explicit arrays replace the selected targets.

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
  configuration?: Record<string, unknown>
  configurationError?: string
}

/** An authentication method configuration as returned by Graph. */
export interface LiveAuthMethodConfig {
  id?: string
  state?: string
  [key:string]:unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const METHOD_CONFIGURATION_FIELDS:Record<string,string[]>={
  fido2:['includeTargets','excludeTargets','keyRestrictions','isAttestationEnforced','isSelfServiceRegistrationAllowed'],
  microsoftAuthenticator:['includeTargets','excludeTargets','featureSettings'],
  sms:['includeTargets','excludeTargets'],
  temporaryAccessPass:['includeTargets','excludeTargets','defaultLifetimeInMinutes','defaultLength','isUsableOnce','minimumLifetimeInMinutes','maximumLifetimeInMinutes'],
  email:['includeTargets','excludeTargets','allowExternalIdToUseEmailOtp'],
  x509Certificate:['includeTargets','excludeTargets','authenticationModeConfiguration','certificateUserBindings'],
  softwareOath:['includeTargets','excludeTargets','isSelfServiceRegistrationAllowed'],
  voice:['includeTargets','excludeTargets'],
  hardwareOath:['includeTargets','excludeTargets'],
}
function methodConfiguration(fields:Record<string,unknown>):Partial<AuthMethodSpec>{
  if(fields.configuration===undefined||fields.configuration==='')return {}
  try{
    const configuration=typeof fields.configuration==='string'?JSON.parse(fields.configuration):fields.configuration
    assertSafeProperties(configuration)
    const allowed=METHOD_CONFIGURATION_FIELDS[String(fields.method)]??[]
    const unknown=Object.keys(configuration).filter(key=>!allowed.includes(key))
    if(unknown.length)throw new Error(`Unsupported method settings: ${unknown.join(', ')}`)
    for(const key of ['includeTargets','excludeTargets'])if(configuration[key]!==undefined && !Array.isArray(configuration[key]))throw new Error(`${key} must be an array`)
    return {configuration}
  }catch(error){return {configurationError:error instanceof Error?error.message:'Invalid method settings'}}
}

export function extractAuthMethodSpecs(canvas: CanvasSnapshot): AuthMethodSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      ...methodConfiguration(f),
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
    if(spec.configurationError)errors.push({field:`${prefix}.configuration`,code:'invalid_method_configuration',message:spec.configurationError})

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

  return { valid: errors.length === 0, errors, warnings: [...warnings, ...capabilityWarnings('authentication-methods-policy')] }
}
