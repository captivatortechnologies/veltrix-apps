import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, type F5xcObjectMetadata } from '../../lib/f5xc'
import {
  extractMaliciousUserMitigationSpecs,
  type LiveMaliciousUserMitigationSpec,
  type LiveMitigationRule,
  type MaliciousUserMitigationSpec,
  type MitigationAction,
  type ThreatLevel,
} from './validate'

const OBJECT_PLURAL = 'malicious_user_mitigations'

export interface MaliciousUserMitigationRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveMaliciousUserMitigationSpec }
}

/**
 * Deploy malicious user mitigation policies to an F5 XC namespace. Objects
 * are identified by NAME (no separate numeric id):
 *   GET  /malicious_user_mitigations/{name}   - 404 means absent
 *   PUT  /malicious_user_mitigations/{name}   - update an existing policy (capture prior)
 *   POST /malicious_user_mitigations          - create a missing policy
 * A matched (existing) policy is only ever UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractMaliciousUserMitigationSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: MaliciousUserMitigationRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveMaliciousUserMitigationSpec>(OBJECT_PLURAL, spec.name)
      const body = {
        metadata: { name: spec.name, description: spec.description, disable: spec.disable },
        spec: buildMaliciousUserMitigationSpecBody(spec),
      }

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: { metadata: stripMetadata(existing.metadata ?? { name: spec.name }), spec: existing.spec ?? {} },
        })
        const res = await client.replace(OBJECT_PLURAL, spec.name, body)
        if (!res.ok) {
          throw new Error(`Failed to update mitigation policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create mitigation policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} malicious user mitigation policy(ies) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedMitigations: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Malicious user mitigation deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedMitigations: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

function actionRule(action: MitigationAction, threatLevel: ThreatLevel): LiveMitigationRule {
  return {
    mitigation_action: { [action]: true } as Partial<Record<MitigationAction, boolean>>,
    threat_level: { [threatLevel]: true } as Partial<Record<ThreatLevel, boolean>>,
  }
}

/** Build the create/replace spec body for one mitigation policy. */
export function buildMaliciousUserMitigationSpecBody(
  spec: MaliciousUserMitigationSpec,
): LiveMaliciousUserMitigationSpec {
  return {
    mitigation_type: {
      rules: [
        actionRule(spec.lowThreatAction, 'low'),
        actionRule(spec.mediumThreatAction, 'medium'),
        actionRule(spec.highThreatAction, 'high'),
      ],
    },
  }
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
