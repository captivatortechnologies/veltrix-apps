import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractAppFirewallSpecs, type AppFirewallSpec, type LiveAppFirewallSpec } from './validate'

const OBJECT_PLURAL = 'app_firewalls'

export interface AppFirewallRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveAppFirewallSpec }
}

/**
 * Deploy App Firewall (WAF) policies to an F5 XC namespace. Objects are
 * identified by NAME (no separate numeric id):
 *   GET  /app_firewalls/{name}   - 404 means absent
 *   PUT  /app_firewalls/{name}   - update an existing policy (capture prior)
 *   POST /app_firewalls          - create a missing policy
 * A matched (existing) policy is only ever UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractAppFirewallSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AppFirewallRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveAppFirewallSpec>(OBJECT_PLURAL, spec.name)
      const body = {
        metadata: { name: spec.name, description: spec.description, disable: spec.disable },
        spec: buildAppFirewallSpecBody(spec),
      }

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: { metadata: stripMetadata(existing.metadata ?? { name: spec.name }), spec: existing.spec ?? {} },
        })
        const res = await client.replace(OBJECT_PLURAL, spec.name, body)
        if (!res.ok) {
          throw new Error(`Failed to update App Firewall "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create App Firewall "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} App Firewall(s) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedAppFirewalls: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `App Firewall deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedAppFirewalls: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one App Firewall policy. */
export function buildAppFirewallSpecBody(spec: AppFirewallSpec): LiveAppFirewallSpec {
  const body: LiveAppFirewallSpec = {
    default_anonymization: true,
    default_detection_settings: true,
    default_bot_setting: spec.enableBotProtection,
  }

  body[spec.enforcementMode] = true

  if (spec.responseCodesMode === 'allow_all_response_codes') {
    body.allow_all_response_codes = true
  } else {
    body.allowed_response_codes = { response_code: spec.allowedResponseCodes }
  }

  if (spec.blockingPageMode === 'use_default_blocking_page') {
    body.use_default_blocking_page = true
  } else {
    body.blocking_page = {
      blocking_page: spec.customBlockingPageHtml || '',
      ...(spec.customBlockingResponseCode ? { response_code: spec.customBlockingResponseCode } : {}),
    }
  }

  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
