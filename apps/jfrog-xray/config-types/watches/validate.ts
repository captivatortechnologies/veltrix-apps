import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { looksLikeEmail, parseJsonArray } from '../../lib/fields'
import { describePolicyNameError } from '../../lib/xrayPolicies'
import { extractWatchSpecs, watchKey, WATCH_RESOURCE_TYPES, type WatchSpec } from './_shared'

const RESOURCE_SCOPES = ['all-repos', 'repository'] as const

/**
 * Validate JFrog Xray watch items. Static — no target access required.
 *   - Watch name is required and must be safe to use as a URL path segment (it
 *     is one — `/xray/api/v2/watches/{name}`); duplicate names are rejected.
 *   - A "repository" scope requires a Repository Name.
 *   - `resources_json`, when set, must be a JSON array of objects each carrying
 *     a string `type` (a recognized Xray resource type is a warning, not an
 *     error, so a newer Xray release's resource types are never hard-rejected).
 *   - Every watch recipient must look like an email address.
 *   - No assigned policy (security or license) is a warning — the watch would
 *     be inert.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractWatchSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one watch.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validateIdentity(spec, prefix, errors, seen)
    validateScope(spec, prefix, errors)
    validateResourcesJson(spec, prefix, errors, warnings)
    validateRecipients(spec, prefix, errors)
    validatePolicyAssignment(spec, prefix, warnings)
    validateTicketing(spec, prefix, warnings)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateIdentity(spec: WatchSpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Watch name is required.', code: 'EMPTY_NAME' })
    return
  }
  const nameError = describePolicyNameError(spec.name)
  if (nameError) errors.push({ field: `${prefix}.name`, message: nameError.replace('Policy name', 'Watch name'), code: 'INVALID_NAME' })

  const key = watchKey(spec.name)
  if (seen.has(key)) {
    errors.push({ field: `${prefix}.name`, message: `Duplicate watch name "${spec.name}" — each name may only be declared once.`, code: 'DUPLICATE_NAME' })
  }
  seen.add(key)
}

function validateScope(spec: WatchSpec, prefix: string, errors: ValidationError[]): void {
  if (!RESOURCE_SCOPES.includes(spec.resourceScope as (typeof RESOURCE_SCOPES)[number])) {
    errors.push({ field: `${prefix}.resource_scope`, message: `Resource scope "${spec.resourceScope}" must be one of ${RESOURCE_SCOPES.join(', ')}.`, code: 'INVALID_SCOPE' })
    return
  }
  if (spec.resourceScope === 'repository' && !spec.repositoryName) {
    errors.push({ field: `${prefix}.repository_name`, message: 'Repository Name is required when the resource scope is "One repository".', code: 'MISSING_REPOSITORY_NAME' })
  }
}

function validateResourcesJson(spec: WatchSpec, prefix: string, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const parsed = parseJsonArray(spec.resourcesJson)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.resources_json`, message: `Additional resources ${parsed.error}.`, code: 'INVALID_JSON' })
    return
  }
  parsed.value.forEach((entry, ri) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field: `${prefix}.resources_json[${ri}]`, message: 'Each additional resource must be a JSON object.', code: 'INVALID_RESOURCE' })
      return
    }
    const type = (entry as { type?: unknown }).type
    if (typeof type !== 'string' || !type.trim()) {
      errors.push({ field: `${prefix}.resources_json[${ri}].type`, message: 'Each additional resource needs a "type".', code: 'INVALID_RESOURCE' })
    } else if (!WATCH_RESOURCE_TYPES.includes(type as (typeof WATCH_RESOURCE_TYPES)[number])) {
      warnings.push({
        field: `${prefix}.resources_json[${ri}].type`,
        message: `Resource type "${type}" is not one of the types verified against the Xray REST API reference (${WATCH_RESOURCE_TYPES.join(', ')}) — it will still be sent as-is.`,
        code: 'UNRECOGNIZED_RESOURCE_TYPE',
      })
    }
  })
}

function validateRecipients(spec: WatchSpec, prefix: string, errors: ValidationError[]): void {
  spec.watchRecipients.forEach((mail, mi) => {
    if (!looksLikeEmail(mail)) {
      errors.push({ field: `${prefix}.watch_recipients[${mi}]`, message: `"${mail}" does not look like an email address.`, code: 'INVALID_EMAIL' })
    }
  })
}

function validatePolicyAssignment(spec: WatchSpec, prefix: string, warnings: ValidationWarning[]): void {
  if (spec.securityPolicyNames.length === 0 && spec.licensePolicyNames.length === 0) {
    warnings.push({
      field: `${prefix}.security_policy_names`,
      message: 'No policy is assigned to this watch — it will monitor its scope but never trigger a policy action.',
      code: 'NO_ASSIGNED_POLICIES',
    })
  }
}

function validateTicketing(spec: WatchSpec, prefix: string, warnings: ValidationWarning[]): void {
  if (spec.createTicketEnabled) {
    warnings.push({
      field: `${prefix}.create_ticket_enabled`,
      message: 'Ticket creation requires a Jira integration already configured in Xray (Administration > Integrations).',
      code: 'TICKET_REQUIRES_JIRA',
    })
  }
}
