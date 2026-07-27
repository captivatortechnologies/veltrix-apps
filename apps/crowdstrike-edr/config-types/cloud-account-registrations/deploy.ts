import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
  type FalconMethod,
} from '../../lib/falcon'
import {
  accountIdentity,
  extractAccountSpecs,
  liveAccountIdentity,
  type AccountSpec,
  type LiveAccount,
} from './validate'

/**
 * Deploy cloud account registrations to Falcon Cloud Security via the LEGACY
 * CSPM Registration collection, dispatching by cloud_provider:
 *   - AWS   /cloud-connect-cspm-aws/entities/account/v1
 *   - Azure /cloud-connect-cspm-azure/entities/account/v1
 *   - GCP   /cloud-connect-cspm-gcp/entities/account/v1
 *
 * For each declared account:
 *   - GET   {path}?ids={providerId}   — find it + capture prior state for rollback
 *   - PATCH {path}                    — update an existing registration's mutable fields
 *   - POST  {path}                    — create a missing registration
 *
 * The account identity is its provider id — account_id (AWS), subscription_id
 * (Azure), project_id → parent_id (GCP) — and is immutable. Only the capability
 * flags and provider-scoped fields (iam_role_arn / cloudtrail_region for AWS,
 * default_subscription for Azure) are written on update.
 *
 * IMPORTANT CAVEAT: registration is NOT self-contained. The API returns setup
 * scripts / console URLs (…/entities/user-scripts-download/v1) — CloudFormation
 * (AWS), an ARM template (Azure), or Terraform/gcloud (GCP) — that the customer
 * must run in THEIR OWN cloud, out-of-band, to create the trust role and grant
 * access. Until they do, the account is "registered" but assessment is not
 * live. This handler performs the registration only; the out-of-band step is
 * the user's, and healthCheck verifies registration (not full activation).
 *
 * Verified request/lookup shapes (FalconPy cspm_registration + CSPM Registration
 * API): create/update bodies are { resources: [ {…} ] }; there is no
 * `cspm_enabled` body key — CSPM (misconfiguration) assessment is the base
 * registration, so registering the account IS enabling it. GCP is modelled in
 * the API as parent_id + parent_type; a project registration fixes
 * parent_type = "project". Azure has specialized update endpoints for some
 * fields (default-subscription/client-id); this bespoke handler converges the
 * mutable fields via PATCH on the account entity.
 */

/** Legacy CSPM Registration account entity path per provider. */
export const PROVIDER_ACCOUNT_PATH: Record<string, string> = {
  aws: '/cloud-connect-cspm-aws/entities/account/v1',
  azure: '/cloud-connect-cspm-azure/entities/account/v1',
  gcp: '/cloud-connect-cspm-gcp/entities/account/v1',
}

/** Account fields this app manages and can restore on rollback. */
export interface AccountRollbackEntry {
  cloudProvider: string
  identity: string
  existed: boolean
  prior?: {
    account_type?: string
    iam_role_arn?: string
    cloudtrail_region?: string
    default_subscription?: boolean
    behavior_assessment_enabled?: boolean
    sensor_management_enabled?: boolean
    dspm_enabled?: boolean
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAccountSpecs(ctx.canvas).filter(
    (s) => providerPath(s.cloudProvider) !== undefined && accountIdentity(s),
  )
  const rollbackState: AccountRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const path = providerPath(spec.cloudProvider)
      if (!path) continue
      const identity = accountIdentity(spec)

      const existing = await findAccount(client, spec.cloudProvider, identity)

      if (existing) {
        rollbackState.push({
          cloudProvider: spec.cloudProvider,
          identity,
          existed: true,
          prior: {
            account_type: existing.account_type,
            iam_role_arn: existing.iam_role_arn,
            cloudtrail_region: existing.cloudtrail_region,
            default_subscription: existing.default_subscription,
            behavior_assessment_enabled: existing.behavior_assessment_enabled,
            sensor_management_enabled: existing.sensor_management_enabled,
            dspm_enabled: existing.dspm_enabled,
          },
        })

        const res = await client.request('PATCH', path, {
          body: { resources: [updateResource(spec)] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update ${spec.cloudProvider} account "${identity}": ${patchFailure}`)
        }
      } else {
        const res = await client.request('POST', path, {
          body: { resources: [createResource(spec)] },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to register ${spec.cloudProvider} account "${identity}": ${createFailure}`)
        }
        rollbackState.push({ cloudProvider: spec.cloudProvider, identity, existed: false })
      }

      deployed.push(`${spec.cloudProvider}:${identity}`)
    }

    return {
      success: true,
      message: `Registered ${deployed.length} cloud account(s) with Falcon Cloud Security at ${baseUrl}: ${deployed.join(
        ', ',
      )}. Run the setup CloudFormation/ARM/Terraform in each cloud to finish onboarding.`,
      artifacts: { baseUrl, deployedAccounts: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Cloud account registration failed after ${deployed.length} of ${specs.length} account(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAccounts: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Prototype-safe endpoint lookup — cloudProvider is user input. */
export function providerPath(provider: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ACCOUNT_PATH, provider)
    ? PROVIDER_ACCOUNT_PATH[provider]
    : undefined
}

/**
 * Look up a registered account by its provider id; null when absent. The CSPM
 * account GET accepts the id via the `ids` query and echoes the account back —
 * a missing id yields 404 or an empty resources array (both mean "not found").
 */
export async function findAccount(
  client: FalconClient,
  provider: string,
  identity: string,
): Promise<LiveAccount | null> {
  const path = providerPath(provider)
  if (!path) return null

  const res = await client.request('GET', path, { query: { ids: identity } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to look up ${provider} account "${identity}": ${falconErrorMessage(res)}`)
  }

  const resources = parseEnvelope<LiveAccount>(res.body)?.resources ?? []
  const norm = (value: string): string => value.trim().toLowerCase()
  return resources.find((r) => norm(liveAccountIdentity(provider, r)) === norm(identity)) ?? null
}

/** Capability flags common to every provider's create/update body. */
function capabilityFields(spec: AccountSpec): Record<string, unknown> {
  // No cspm_enabled key: CSPM is the base registration, not a toggle.
  return {
    behavior_assessment_enabled: spec.behaviorAssessmentEnabled,
    sensor_management_enabled: spec.sensorManagementEnabled,
    dspm_enabled: spec.dspmEnabled,
  }
}

/** Full registration body for a new account (identity + immutables + capabilities). */
export function createResource(spec: AccountSpec): Record<string, unknown> {
  const base = { account_type: spec.accountType, ...capabilityFields(spec) }
  switch (spec.cloudProvider) {
    case 'aws':
      return {
        account_id: spec.accountId,
        ...(spec.iamRoleArn ? { iam_role_arn: spec.iamRoleArn } : {}),
        ...(spec.regions[0] ? { cloudtrail_region: spec.regions[0] } : {}),
        ...base,
      }
    case 'azure':
      return {
        subscription_id: spec.subscriptionId,
        tenant_id: spec.tenantId,
        default_subscription: spec.defaultSubscription,
        ...base,
      }
    case 'gcp':
      return { parent_id: spec.projectId, parent_type: 'project', ...base }
    default:
      return base
  }
}

/** Mutable-only body for an existing account (identity + fields we can converge). */
export function updateResource(spec: AccountSpec): Record<string, unknown> {
  // account_type / tenant_id / parent_type are immutable, so they are omitted here.
  switch (spec.cloudProvider) {
    case 'aws':
      return {
        account_id: spec.accountId,
        ...(spec.iamRoleArn ? { iam_role_arn: spec.iamRoleArn } : {}),
        ...(spec.regions[0] ? { cloudtrail_region: spec.regions[0] } : {}),
        ...capabilityFields(spec),
      }
    case 'azure':
      return {
        subscription_id: spec.subscriptionId,
        default_subscription: spec.defaultSubscription,
        ...capabilityFields(spec),
      }
    case 'gcp':
      return { parent_id: spec.projectId, ...capabilityFields(spec) }
    default:
      return capabilityFields(spec)
  }
}

/** Identity-only body fragment keyed the way each provider names its id (for restore). */
export function identityBody(provider: string, identity: string): Record<string, unknown> {
  switch (provider) {
    case 'aws':
      return { account_id: identity }
    case 'azure':
      return { subscription_id: identity }
    case 'gcp':
      return { parent_id: identity }
    default:
      return {}
  }
}

/** Verb used to converge an existing registration. */
export const UPDATE_METHOD: FalconMethod = 'PATCH'
