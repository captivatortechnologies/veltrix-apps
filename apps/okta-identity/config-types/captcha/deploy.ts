import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractCaptchaSpecs,
  type CaptchaSpec,
  type LiveCaptchaInstance,
  type LiveOrgCaptcha,
} from './validate'

export interface CaptchaRollbackData {
  /** True when the instance already existed (updated in place); false when created. */
  instanceExisted: boolean
  /** The instance id Okta assigns/holds — the rollback key. */
  instanceId?: string
  /** Prior instance body with server-managed fields stripped (secretKey can never be restored — write-only). */
  priorInstance?: Record<string, unknown>
  /** Prior org-wide CAPTCHA settings, restored via PUT on rollback. */
  priorOrg?: { captchaId: string | null; enabledPages: string[] | null }
}

/** Server-managed fields Okta returns on a CAPTCHA instance but that must never be sent back. */
export const READONLY_CAPTCHA_FIELDS = ['id', '_links'] as const

/**
 * Deploy the org's CAPTCHA. An org supports AT MOST ONE instance, so there is no
 * list/match by name — the single existing instance (if any) is updated, else one
 * is created:
 *   - GET  /captchas               — is there already an instance?
 *   - POST /captchas               — create (needs the write-only secretKey)
 *   - PUT  /captchas/{id}          — replace an existing instance (secretKey re-sent)
 * then the org-wide enablement is set (a full replace):
 *   - GET  /org/captcha            — capture prior settings (for rollback)
 *   - PUT  /org/captcha            — {captchaId, enabledPages}; empty pages DISABLES it
 *
 * The write-only secretKey is re-asserted on every deploy (Okta never returns it,
 * so a PUT that omitted it would clear it).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCaptchaSpecs(ctx.canvas).filter((s) => s.name && s.type && s.siteKey)
  if (specs.length === 0) {
    return { success: false, message: 'No CAPTCHA configuration provided' }
  }
  const spec = specs[0]

  try {
    // Capture prior org-wide settings first — restored on rollback and needed to
    // detach a created instance before it can be deleted.
    const currentOrg = await getOrgCaptcha(client)
    const rollbackData: CaptchaRollbackData = {
      instanceExisted: false,
      priorOrg: {
        captchaId: typeof currentOrg?.captchaId === 'string' ? currentOrg.captchaId : null,
        enabledPages: Array.isArray(currentOrg?.enabledPages) ? currentOrg!.enabledPages!.map(String) : null,
      },
    }

    // Instance: update the single existing one, or create it.
    const existing = await getCaptchaInstance(client)
    let instanceId: string
    if (existing && existing.id) {
      rollbackData.instanceExisted = true
      rollbackData.instanceId = existing.id
      rollbackData.priorInstance = stripReadOnlyCaptchaFields(existing)

      const res = await client.request('PUT', `/captchas/${existing.id}`, { body: buildInstanceBody(spec) })
      if (!res.ok) {
        throw new Error(`Failed to update CAPTCHA instance "${spec.name}": ${oktaErrorMessage(res)}`)
      }
      instanceId = existing.id
    } else {
      const res = await client.request('POST', '/captchas', { body: buildInstanceBody(spec) })
      if (!res.ok) {
        throw new Error(`Failed to create CAPTCHA instance "${spec.name}": ${oktaErrorMessage(res)}`)
      }
      const created = parseJson<LiveCaptchaInstance>(res.body)
      if (!created?.id) {
        throw new Error(`CAPTCHA instance "${spec.name}" was created but the API returned no id`)
      }
      instanceId = created.id
      rollbackData.instanceExisted = false
      rollbackData.instanceId = created.id
    }

    // Org-wide enablement — full replace. Empty pages disables the CAPTCHA org-wide.
    const orgBody =
      spec.enabledPages.length > 0
        ? { captchaId: instanceId, enabledPages: spec.enabledPages }
        : { captchaId: null, enabledPages: null }
    const orgRes = await client.request('PUT', '/org/captcha', { body: orgBody })
    if (!orgRes.ok) {
      throw new Error(`Failed to update org-wide CAPTCHA settings: ${oktaErrorMessage(orgRes)}`)
    }

    const enablement =
      spec.enabledPages.length > 0 ? `enabled on ${spec.enabledPages.join(', ')}` : 'configured but disabled org-wide'
    return {
      success: true,
      message: `Deployed CAPTCHA "${spec.name}" (${spec.type}) to Okta org at ${baseUrl}: ${enablement}.`,
      artifacts: { baseUrl, instanceId, enabledPages: spec.enabledPages },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `CAPTCHA deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Read the single CAPTCHA instance (null when the org has none). */
export async function getCaptchaInstance(client: OktaClient): Promise<LiveCaptchaInstance | null> {
  const res = await client.getAll<LiveCaptchaInstance>('/captchas')
  if (!res.ok) {
    throw new Error(
      `Failed to list CAPTCHA instances: ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items[0] ?? null
}

/** Read the org-wide CAPTCHA settings (empty object when unconfigured). */
export async function getOrgCaptcha(client: OktaClient): Promise<LiveOrgCaptcha | null> {
  const res = await client.request('GET', '/org/captcha')
  if (!res.ok) {
    throw new Error(`Failed to read org-wide CAPTCHA settings: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveOrgCaptcha>(res.body)
}

/**
 * Build the instance create/replace body. The write-only secretKey is included
 * only when supplied (it is required by validate, so it is always present on a
 * real deploy) — Okta never returns it, so a PUT must re-send it or it is cleared.
 */
export function buildInstanceBody(spec: CaptchaSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, type: spec.type, siteKey: spec.siteKey }
  if (spec.secretKey) body.secretKey = spec.secretKey
  return body
}

/** Copy a live instance without server-managed fields (safe to PUT back). */
export function stripReadOnlyCaptchaFields(instance: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(instance)) {
    if (!(READONLY_CAPTCHA_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
