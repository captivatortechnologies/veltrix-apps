import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'
import { buildCloudflareAccountClient, cloudflareErrorMessage } from '../../lib/cloudflare'

// =============================================================================
// Live options provider for the Cloudflare config canvas. Powers the canvas-level
// "Domain" picker on zone-scoped config types (DNS, WAF, rate-limiting, redirect,
// transform, managed rulesets, zone settings) via the platform's config-options
// route (source = "zones"). The platform resolves the connection (decrypted
// credential + component) for the config type and runs this in-process, so it
// calls the Cloudflare API directly to list the account's zones.
//
// The OptionItem / OptionsProviderContext contract is declared locally: the
// platform passes a context object and consumes the returned OptionItem[]
// structurally, and the SDK build installed here predates those type exports.
// The shapes mirror @veltrixsecops/app-sdk's pipeline types exactly.
// =============================================================================

/** One selectable option returned to a live picker. */
export interface OptionItem {
  value: string
  label: string
  description?: string
}

/** Context the platform passes to a live options provider. */
export interface OptionsProviderContext {
  appId: string
  customerId: string
  configTypeId: string
  source: string
  query?: string
  component: ComponentRef | null
  credential: CredentialRef | null
  connectivityProvider?: { config?: Record<string, unknown> | null } | null
  settings: Record<string, unknown>
}

export type OptionsProvider = (ctx: OptionsProviderContext) => Promise<OptionItem[]>

/**
 * The canvas-level Domain picker source name, shared by every zone-scoped type.
 * The client requests config-options with this `source`; the platform runs this
 * provider, which returns the account's zones as domain options.
 */
export const ZONES_SOURCE = 'zones'

const cloudflareOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  if (ctx.source !== ZONES_SOURCE) return []
  if (!ctx.credential) {
    throw new Error('No Cloudflare API token available — store a token on the connection first.')
  }

  const built = buildCloudflareAccountClient(ctx.credential, ctx.settings ?? {})
  if ('error' in built) throw new Error(built.error)

  const res = await built.client.listZones()
  if (!res.ok) {
    throw new Error(
      `Failed to list Cloudflare zones: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }

  const needle = (ctx.query ?? '').trim().toLowerCase()
  const items = res.items
    .filter((z) => typeof z.name === 'string' && z.name.length > 0)
    .map((z) => ({ value: z.name, label: z.name, description: z.status }))
  return needle ? items.filter((o) => o.label.toLowerCase().includes(needle)) : items
}

export default cloudflareOptions
