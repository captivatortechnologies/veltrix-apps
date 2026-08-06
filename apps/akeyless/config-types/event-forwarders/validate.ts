import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Event Forwarders API constraints ---------------------------------
// https://docs.akeyless.io
//   POST /event-forwarder-create-slack|email|webhook|teams|servicenow
//   POST /event-forwarder-update-{type}
//   POST /event-forwarder-delete, /event-forwarder-get
// Identity is the config's NAME; TYPE is fixed at creation (immutable).
// No list endpoint exists for this object type (see canvas.yaml header).

export const EVENT_FORWARDER_TYPES = ['slack', 'email', 'webhook', 'teams', 'servicenow'] as const
export type EventForwarderType = (typeof EVENT_FORWARDER_TYPES)[number]

export interface EventForwarderSpec {
  sectionName: string
  name: string
  type: EventForwarderType | ''
  description: string
  enable: boolean
  runnerType: string
  every: string
  itemsEventSourceLocations: string[]
  targetsEventSourceLocations: string[]
  authMethodsEventSourceLocations: string[]
  gatewaysEventSourceLocations: string[]
  eventTypes: string[]
  // slack / teams
  webhookUrl: string
  webhookUrlTeams: string
  // email
  emailTo: string
  overrideUrl: string
  includeError: boolean
  // webhook
  url: string
  authType: string
  username: string
  password: string
  authToken: string
  serverCertificates: string
  clientCertData: string
  privateKeyData: string
  // servicenow
  host: string
  serviceNowAuthType: string
  adminName: string
  adminPwd: string
  userEmail: string
  clientId: string
  clientSecret: string
  appPrivateKeyBase64: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Each canvas item describes one Akeyless event forwarder. */
export function extractEventForwarderSpecs(canvas: CanvasSnapshot): EventForwarderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      type: (EVENT_FORWARDER_TYPES as readonly string[]).includes(str(f.type)) ? (str(f.type) as EventForwarderType) : '',
      description: str(f.description),
      enable: f.enable === undefined ? true : bool(f.enable),
      runnerType: str(f.runnerType) || 'immediate',
      every: str(f.every),
      itemsEventSourceLocations: toStringList(f.itemsEventSourceLocations),
      targetsEventSourceLocations: toStringList(f.targetsEventSourceLocations),
      authMethodsEventSourceLocations: toStringList(f.authMethodsEventSourceLocations),
      gatewaysEventSourceLocations: toStringList(f.gatewaysEventSourceLocations),
      eventTypes: toStringList(f.eventTypes),
      webhookUrl: str(f.webhookUrl),
      webhookUrlTeams: str(f.webhookUrlTeams),
      emailTo: str(f.emailTo),
      overrideUrl: str(f.overrideUrl),
      includeError: bool(f.includeError),
      url: str(f.url),
      authType: str(f.authType) || 'user-pass',
      username: str(f.username),
      password: str(f.password),
      authToken: str(f.authToken),
      serverCertificates: str(f.serverCertificates),
      clientCertData: str(f.clientCertData),
      privateKeyData: str(f.privateKeyData),
      host: str(f.host),
      serviceNowAuthType: str(f.serviceNowAuthType) || 'user-pass',
      adminName: str(f.adminName),
      adminPwd: str(f.adminPwd),
      userEmail: str(f.userEmail),
      clientId: str(f.clientId),
      clientSecret: str(f.clientSecret),
      appPrivateKeyBase64: str(f.appPrivateKeyBase64),
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEventForwarderSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate event forwarder "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: `Type is required and must be one of: ${EVENT_FORWARDER_TYPES.join(', ')}`, code: 'required' })
      continue
    }

    if (spec.type === 'teams') {
      if (spec.gatewaysEventSourceLocations.length === 0) {
        errors.push({ field: `${prefix}.gatewaysEventSourceLocations`, message: 'Gateway Event Sources is required for Microsoft Teams', code: 'required' })
      }
      if (!spec.webhookUrlTeams) {
        errors.push({ field: `${prefix}.webhookUrlTeams`, message: 'Webhook URL is required for Microsoft Teams (on every deploy)', code: 'required' })
      }
    }

    if (spec.type === 'webhook' && !['user-pass', 'bearer-token', 'certificate'].includes(spec.authType)) {
      errors.push({ field: `${prefix}.authType`, message: 'Authentication Type must be user-pass, bearer-token or certificate', code: 'invalid_value' })
    }
    if (spec.type === 'servicenow' && !['user-pass', 'jwt'].includes(spec.serviceNowAuthType)) {
      errors.push({ field: `${prefix}.serviceNowAuthType`, message: 'Authentication Type must be user-pass or jwt', code: 'invalid_value' })
    }
    if (spec.type === 'email' && !spec.emailTo) {
      warnings.push({ field: `${prefix}.emailTo`, message: 'No Recipients set - Akeyless will reject this forwarder without at least one email address.', code: 'missing_recipients' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
