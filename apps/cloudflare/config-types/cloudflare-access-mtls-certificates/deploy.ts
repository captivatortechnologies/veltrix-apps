import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractMtlsCertificateSpecs,
  mtlsCertificateKey,
  type LiveMtlsCertificate,
  type MtlsCertificateSpec,
} from './validate'

export interface MtlsCertificateRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveMtlsCertificate
}

/**
 * Deploy Cloudflare Access mTLS certificates via the API (account-scoped).
 *
 * Identity is the certificate `name`: list /access/certificates, match on the
 * name, then PUT an existing certificate by id or POST a new one. Cloudflare's
 * PUT does not accept `certificate` — the PEM content is immutable once
 * created, so an update only resends name/associated_hostnames.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractMtlsCertificateSpecs(ctx.canvas).filter((s) => s.name && s.associatedHostnames.length > 0)
  const rollbackState: MtlsCertificateRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listCertificates(client)
    const byKey = new Map(existing.filter((c) => c.name).map((c) => [mtlsCertificateKey(c.name as string), c]))

    for (const spec of specs) {
      const label = spec.name
      const key = mtlsCertificateKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/access/certificates/${live.id}`, { body: buildUpdatePayload(spec) })
        if (!res.ok) throw new Error(`Failed to update mTLS certificate "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        if (!spec.certificate) {
          throw new Error(`Certificate "${label}" has no PEM content to create it with`)
        }
        const res = await client.account('POST', '/access/certificates', { body: buildCreatePayload(spec) })
        if (!res.ok) throw new Error(`Failed to create mTLS certificate "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveMtlsCertificate>(res)
        if (!created?.id) throw new Error(`mTLS certificate "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} mTLS certificate(s) to account for "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedCertificates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `mTLS certificate deployment failed after ${deployed.length} of ${specs.length} certificate(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedCertificates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Access mTLS certificates in the account; throws on a non-OK response. */
export async function listCertificates(client: CloudflareClient): Promise<LiveMtlsCertificate[]> {
  const res = await client.accountGetAll<LiveMtlsCertificate>('/access/certificates')
  if (!res.ok) {
    throw new Error(
      `Failed to list Access mTLS certificates: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Create body — the only request that may include the PEM certificate content. */
export function buildCreatePayload(spec: MtlsCertificateSpec): Record<string, unknown> {
  return {
    name: spec.name,
    certificate: spec.certificate,
    associated_hostnames: spec.associatedHostnames,
  }
}

/** Update body — Cloudflare's PUT only accepts name + associated_hostnames. */
export function buildUpdatePayload(spec: MtlsCertificateSpec): Record<string, unknown> {
  return {
    name: spec.name,
    associated_hostnames: spec.associatedHostnames,
  }
}
