import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- OneLogin Apps API constraints ---------------------------------------------
// https://developers.onelogin.com/api-docs/2/apps
//
// GET/POST       /api/2/apps        - list (bare array) / create
// GET/PUT/DELETE /api/2/apps/{id}   - read / partial update / delete
//
// An app's logical identity in this config type is its NAME (OneLogin itself
// has no uniqueness constraint on app name, but this app treats name as the
// stable key it matches on - the same convention ping-identity/auth0 use for
// their Applications config types, since OneLogin has no upsert).

export const MAX_APP_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface AppSpec {
  sectionName: string
  name: string
  connectorId?: number
  description?: string
  notes?: string
  visible: boolean
  allowAssumedSignin: boolean
  policyId?: number
  tabId?: number
  provisioningEnabled: boolean
  /** Raw JSON text from the canvas; parse with {@link parseJsonObject}. */
  configurationJson?: string
  parametersJson?: string
}

/**
 * Shape of an app returned by GET /api/2/apps (list) and GET /api/2/apps/{id}
 * (get). Read-only fields (id, auth_method, auth_method_description, sso,
 * icon_url, created_at, updated_at, role_ids, connector_id once created) are
 * carried for completeness but never sent back on update - `sso` in
 * particular holds server-generated, sometimes secret, values (an OIDC app's
 * client_id/client_secret, a SAML app's ACS/SLS URLs and certificate) that
 * this app treats as read-only/write-only-elsewhere, never round-tripped.
 */
export interface LiveApp {
  id?: number
  connector_id?: number
  name?: string
  description?: string | null
  notes?: string | null
  visible?: boolean
  allow_assumed_signin?: boolean
  policy_id?: number | null
  tab_id?: number | null
  provisioning?: { enabled?: boolean }
  configuration?: Record<string, unknown>
  parameters?: Record<string, unknown>
  auth_method?: number
  auth_method_description?: string
  sso?: Record<string, unknown>
  role_ids?: number[]
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function boolWithDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Each canvas item describes one OneLogin app. */
export function extractAppSpecs(canvas: CanvasSnapshot): AppSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      connectorId: numberOrUndefined(fields.connectorId),
      description: trimmedOrUndefined(fields.description),
      notes: trimmedOrUndefined(fields.notes),
      visible: boolWithDefault(fields.visible, true),
      allowAssumedSignin: boolWithDefault(fields.allowAssumedSignin, false),
      policyId: numberOrUndefined(fields.policyId),
      tabId: numberOrUndefined(fields.tabId),
      provisioningEnabled: boolWithDefault(fields.provisioningEnabled, false),
      configurationJson: trimmedOrUndefined(fields.configurationJson),
      parametersJson: trimmedOrUndefined(fields.parametersJson),
    }
  })
}

/**
 * Parse a raw JSON string, returning the object or null when it is not a JSON
 * OBJECT (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy/driftDetect (to build the
 * `configuration`/`parameters` values).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate app configurations against the OneLogin Apps API. Static only - it
 * never contacts OneLogin (the Connector picker is resolved live by the
 * platform's remote-select UI via options.ts, not here):
 *   - name is required and <= 255 characters, and unique across the canvas
 *   - connectorId is required and must be a positive integer
 *   - policyId/tabId, when present, must be positive integers
 *   - configurationJson/parametersJson, when present, must each parse to a
 *     JSON object
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'App name is required', code: 'required' })
    } else if (spec.name.length > MAX_APP_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `App name must be ${MAX_APP_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate app "${spec.name}" - each app name may only be declared once per canvas`,
        code: 'duplicate_app',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    if (spec.connectorId === undefined) {
      errors.push({ field: `${prefix}.connectorId`, message: 'Connector is required', code: 'required' })
    } else if (!Number.isInteger(spec.connectorId) || spec.connectorId <= 0) {
      errors.push({
        field: `${prefix}.connectorId`,
        message: 'Connector must be a positive integer id',
        code: 'invalid_connector_id',
      })
    }

    if (spec.policyId !== undefined && (!Number.isInteger(spec.policyId) || spec.policyId <= 0)) {
      errors.push({
        field: `${prefix}.policyId`,
        message: 'Login Policy ID must be a positive integer',
        code: 'invalid_policy_id',
      })
    }
    if (spec.tabId !== undefined && (!Number.isInteger(spec.tabId) || spec.tabId <= 0)) {
      errors.push({ field: `${prefix}.tabId`, message: 'Portal Tab ID must be a positive integer', code: 'invalid_tab_id' })
    }

    if (spec.configurationJson && parseJsonObject(spec.configurationJson) === null) {
      errors.push({
        field: `${prefix}.configurationJson`,
        message: 'Configuration must be a valid JSON object, e.g. {"redirect_uri":"https://app.example.com/callback"}',
        code: 'invalid_configuration',
      })
    }
    if (spec.parametersJson && parseJsonObject(spec.parametersJson) === null) {
      errors.push({
        field: `${prefix}.parametersJson`,
        message: 'Parameters must be a valid JSON object, e.g. {"saml_username":{"user_attribute_mappings":"samaccountname"}}',
        code: 'invalid_parameters',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
