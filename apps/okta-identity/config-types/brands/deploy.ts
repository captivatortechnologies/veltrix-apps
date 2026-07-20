import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  extractBrandSpecs,
  hasThemeChange,
  parseConfigObject,
  type BrandSpec,
  type LiveBrand,
  type LiveTheme,
} from './validate'

export interface BrandRollbackEntry {
  name: string
  existed: boolean
  /** The brand id Okta assigns/holds — the rollback key (never the name). */
  id?: string
  /** Prior brand body with server-managed fields stripped, replayed via PUT on rollback. */
  priorBrand?: Record<string, unknown>
  /** The theme id under the brand (when a theme change was applied). */
  themeId?: string
  /** Prior theme body with server-managed fields stripped, replayed via PUT on rollback. */
  priorTheme?: Record<string, unknown>
}

/** Server-managed fields Okta returns on a brand but that must never be sent back. */
export const READONLY_BRAND_FIELDS = ['id', 'isDefault', '_links', '_embedded'] as const

/** Server-managed fields Okta returns on a theme but that must never be sent back (logos are binary). */
export const READONLY_THEME_FIELDS = ['id', 'logo', 'favicon', 'backgroundImage', '_links', '_embedded'] as const

/**
 * Deploy brands to an Okta org. NO UPSERT exists, so for each declared brand:
 *   - GET  /brands              — list (paginated) and match by name
 *   - POST /brands              — create a missing brand (minimal {name})
 *   - PUT  /brands/{id}         — apply the full brand body (capture prior)
 * then reconcile the brand's single THEME as a sub-resource (only when the canvas
 * declares any theme change):
 *   - GET  /brands/{id}/themes            — the single theme
 *   - PUT  /brands/{id}/themes/{themeId}  — colours + variants (capture prior)
 *
 * The default brand (isDefault:true) is only ever UPDATED in place — deploy never
 * deletes, so a matched default brand is safe to converge.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractBrandSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: BrandRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Validate the theme variants blob up-front so we fail loudly.
      const themeConfig = spec.themeConfigJson ? parseConfigObject(spec.themeConfigJson) : {}
      if (themeConfig === null) {
        throw new Error(`Brand "${spec.name}": theme variants (themeConfigJson) is not a valid JSON object`)
      }

      const existing = await findBrand(client, spec.name)
      const entry: BrandRollbackEntry = { name: spec.name, existed: false }

      let brandId: string
      if (existing && existing.id) {
        entry.existed = true
        entry.id = existing.id
        entry.priorBrand = stripReadOnlyBrandFields(existing)
        const res = await client.request('PUT', `/brands/${existing.id}`, { body: buildBrandBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update brand "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        brandId = existing.id
      } else {
        // Create minimal, then apply the full body (POST accepts only {name}).
        const createRes = await client.request('POST', '/brands', { body: { name: spec.name } })
        if (!createRes.ok) {
          throw new Error(`Failed to create brand "${spec.name}": ${oktaErrorMessage(createRes)}`)
        }
        const created = parseJson<LiveBrand>(createRes.body)
        if (!created?.id) {
          throw new Error(`Brand "${spec.name}" was created but the API returned no id`)
        }
        brandId = created.id
        entry.id = created.id
        createdIds.push(created.id)
        const putRes = await client.request('PUT', `/brands/${brandId}`, { body: buildBrandBody(spec) })
        if (!putRes.ok) {
          throw new Error(`Failed to apply settings to new brand "${spec.name}": ${oktaErrorMessage(putRes)}`)
        }
      }

      // Reconcile the theme only when the canvas declares any theme change.
      if (hasThemeChange(spec)) {
        const theme = await getBrandTheme(client, brandId)
        if (!theme?.id) {
          throw new Error(`Brand "${spec.name}" has no theme to update`)
        }
        entry.themeId = theme.id
        entry.priorTheme = stripReadOnlyThemeFields(theme)
        const themeRes = await client.request('PUT', `/brands/${brandId}/themes/${theme.id}`, {
          body: buildThemeBody(spec, themeConfig, theme),
        })
        if (!themeRes.ok) {
          throw new Error(`Failed to update theme for brand "${spec.name}": ${oktaErrorMessage(themeRes)}`)
        }
      }

      rollbackState.push(entry)
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} brand(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedBrands: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Brand deployment failed after ${deployed.length} of ${specs.length} brand(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedBrands: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Find a brand by exact name across the paginated brand list; null when absent. */
export async function findBrand(client: OktaClient, name: string): Promise<LiveBrand | null> {
  const res = await client.getAll<LiveBrand>('/brands')
  if (!res.ok) {
    throw new Error(
      `Failed to list brands while resolving "${name}": ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items.find((b) => b.name === name) ?? null
}

/** Fetch a brand by id; null on 404. */
export async function getBrandById(client: OktaClient, id: string): Promise<LiveBrand | null> {
  const res = await client.request('GET', `/brands/${id}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch brand ${id}: ${oktaErrorMessage(res)}`)
  return parseJson<LiveBrand>(res.body)
}

/** Fetch the single theme under a brand (Okta supports one theme per brand). */
export async function getBrandTheme(client: OktaClient, brandId: string): Promise<LiveTheme | null> {
  const res = await client.getAll<LiveTheme>(`/brands/${brandId}/themes`)
  if (!res.ok) {
    throw new Error(
      `Failed to list themes for brand ${brandId}: ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items[0] ?? null
}

/**
 * Build the brand PUT body (BrandRequest). name is always sent; the boolean flags
 * are always sent; optional URL/locale/emailDomainId are sent only when set (a
 * PUT is a full replace, so omitting them clears them).
 */
export function buildBrandBody(spec: BrandSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    removePoweredByOkta: spec.removePoweredByOkta,
    agreeToCustomPrivacyPolicy: spec.agreeToCustomPrivacyPolicy,
  }
  if (spec.customPrivacyPolicyUrl) body.customPrivacyPolicyUrl = spec.customPrivacyPolicyUrl
  if (spec.locale) body.locale = spec.locale
  if (spec.emailDomainId) body.emailDomainId = spec.emailDomainId
  return body
}

/**
 * Build the theme PUT body (UpdateThemeRequest). Colours come from the modeled
 * fields; the variants blob is merged in. Any colour the canvas leaves blank
 * falls back to the live theme's current value so a PUT never clears it.
 */
export function buildThemeBody(
  spec: BrandSpec,
  themeConfig: Record<string, unknown>,
  live: LiveTheme,
): Record<string, unknown> {
  return {
    ...themeConfig,
    primaryColorHex: spec.primaryColorHex ?? live.primaryColorHex,
    primaryColorContrastHex: spec.primaryColorContrastHex ?? live.primaryColorContrastHex,
    secondaryColorHex: spec.secondaryColorHex ?? live.secondaryColorHex,
    secondaryColorContrastHex: spec.secondaryColorContrastHex ?? live.secondaryColorContrastHex,
  }
}

/** Copy a live brand without server-managed fields (safe to PUT back). */
export function stripReadOnlyBrandFields(brand: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(brand)) {
    if (!(READONLY_BRAND_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

/** Copy a live theme without server-managed fields (safe to PUT back). */
export function stripReadOnlyThemeFields(theme: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (!(READONLY_THEME_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}
