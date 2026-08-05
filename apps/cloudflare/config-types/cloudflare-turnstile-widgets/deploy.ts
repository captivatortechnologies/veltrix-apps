import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractTurnstileWidgetSpecs,
  widgetKey,
  type LiveTurnstileWidget,
  type TurnstileWidgetSpec,
} from './validate'

/**
 * Rollback record for one widget.
 *
 * ⚠ SECURITY: this NEVER carries `secret`. For created widgets we keep only the
 * server-assigned `sitekey` (so it can be deleted); for updated widgets we keep
 * the prior editable fields (so they can be restored). The write-only secret is
 * never captured — Cloudflare redacts it on every read after creation anyway.
 */
export interface TurnstileWidgetRollbackEntry {
  key: string
  label: string
  existed: boolean
  sitekey?: string
  prior?: LiveTurnstileWidget
}

/**
 * Deploy Cloudflare Turnstile widgets via the API (account-scoped).
 *
 * Identity is the widget `name`: list /challenges/widgets, match on the name,
 * then PUT an existing widget by sitekey or POST a new one. `region` is fixed
 * at creation — Cloudflare ignores or rejects changing it afterward, so an
 * update always resends the declared value but a live widget already created
 * under a different region will not move.
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

  const specs = extractTurnstileWidgetSpecs(ctx.canvas).filter((s) => s.name && s.domains.length > 0)
  const rollbackState: TurnstileWidgetRollbackEntry[] = []
  const createdSitekeys: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listWidgets(client)
    const byKey = new Map(existing.filter((w) => w.name).map((w) => [widgetKey(w.name as string), w]))

    for (const spec of specs) {
      const label = spec.name
      const key = widgetKey(spec.name)
      const live = byKey.get(key)
      const body = buildPayload(spec)

      if (live && live.sitekey) {
        rollbackState.push({ key, label, existed: true, sitekey: live.sitekey, prior: live })
        const res = await client.account('PUT', `/challenges/widgets/${live.sitekey}`, { body })
        if (!res.ok) throw new Error(`Failed to update Turnstile widget "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/challenges/widgets', { body })
        if (!res.ok) throw new Error(`Failed to create Turnstile widget "${label}": ${cloudflareErrorMessage(res)}`)
        // ⚠ The response also carries `secret` (shown once). We read ONLY the
        // sitekey and deliberately never touch, log or persist the secret.
        const created = cloudflareResult<LiveTurnstileWidget>(res)
        if (!created?.sitekey) throw new Error(`Turnstile widget "${label}" was created but the API returned no sitekey`)
        rollbackState.push({ key, label, existed: false, sitekey: created.sitekey })
        createdSitekeys.push(created.sitekey)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Turnstile widget(s) to account for "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedWidgets: deployed },
      rollbackData: { previousState: rollbackState, createdSitekeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `Turnstile widget deployment failed after ${deployed.length} of ${specs.length} widget(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedWidgets: deployed },
      rollbackData: { previousState: rollbackState, createdSitekeys },
    }
  }
}

// --- Helpers ---

/** List all Turnstile widgets in the account; throws on a non-OK response. */
export async function listWidgets(client: CloudflareClient): Promise<LiveTurnstileWidget[]> {
  const res = await client.accountGetAll<LiveTurnstileWidget>('/challenges/widgets')
  if (!res.ok) {
    throw new Error(
      `Failed to list Turnstile widgets: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Build the create/update body. Never includes a secret — the API generates it. */
export function buildPayload(spec: TurnstileWidgetSpec): Record<string, unknown> {
  return {
    name: spec.name,
    mode: spec.mode,
    domains: spec.domains,
    bot_fight_mode: spec.botFightMode,
    region: spec.region,
    offlabel: spec.offlabel,
    ephemeral_id: spec.ephemeralId,
    clearance_level: spec.clearanceLevel,
  }
}
