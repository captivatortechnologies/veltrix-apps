import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, type OneLoginClient } from '../../lib/oneLogin'
import { extractBrandSpecs, type BrandSpec, type LiveBrand } from './validate'

/** The full writable surface of a brand - everything create/update accepts (excludes logo/background - see canvas.yaml). */
export interface BrandWriteInput {
  name: string
  enabled: boolean
  customColor?: string
  customAccentColor?: string
  customMaskingColor?: string
  customMaskingOpacity?: number
  enableCustomLabelForLoginScreen: boolean
  customLabelTextForLoginScreen?: string
  loginInstructionTitle?: string
  loginInstruction?: string
  hideOneloginFooter: boolean
  mfaEnrollmentMessage?: string
  customSupportEnabled: boolean
}

export interface BrandRollbackEntry {
  name: string
  existed: boolean
  id?: number
  prior?: BrandWriteInput
}

/**
 * Deploy OneLogin Account Brands via the (Early Preview) Branding API.
 *
 * ONE item = ONE brand, matched on NAME (OneLogin has no upsert):
 *   - list GET  /api/2/branding/brands           (client.getAll, Link-header paginated)
 *   - PUT       /api/2/branding/brands/{id}      - partial update ("accepts a
 *     partial payload but only updates the provided values") - this app
 *     always sends every field it manages, so a field cleared in the canvas
 *     converges to cleared in OneLogin
 *   - POST      /api/2/branding/brands           - create a missing one (capture the new id)
 *
 * NEVER creates or deletes the account's MASTER brand (master: true) - a
 * brand this canvas names after an existing master brand only has its
 * non-identity fields updated.
 *
 * Never deletes a (non-master) brand absent from this canvas - rollback only
 * reverts what THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractBrandSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: BrandRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const brands = await listBrands(client)

    for (const spec of specs) {
      const input = specToWriteInput(spec)
      const existing = brands.find((b) => b.name === spec.name) ?? null

      if (existing?.id) {
        rollbackState.push({ name: spec.name, existed: true, id: existing.id, prior: liveBrandToWriteInput(existing) })

        const res = await client.request('PUT', `/api/2/branding/brands/${existing.id}`, { body: buildBrandBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to update brand "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/api/2/branding/brands', { body: buildBrandBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to create brand "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        const created = parseJson<LiveBrand>(res.body)
        if (!created?.id) {
          throw new Error(`Brand "${spec.name}" was created but the API returned no id`)
        }
        createdIds.push(created.id)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} brand(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedBrands: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Brand deployment failed after ${deployed.length} of ${specs.length} brand(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedBrands: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every brand in the account, following Link-header pagination. */
export async function listBrands(client: OneLoginClient): Promise<LiveBrand[]> {
  const res = await client.getAll<LiveBrand>('/api/2/branding/brands')
  if (!res.ok) {
    throw new Error(
      `Failed to list brands: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}. ` +
        'The Branding API is an OneLogin Early Preview feature - confirm it is enabled for this account.',
    )
  }
  return res.items
}

function specToWriteInput(spec: BrandSpec): BrandWriteInput {
  return {
    name: spec.name,
    enabled: spec.enabled,
    customColor: spec.customColor,
    customAccentColor: spec.customAccentColor,
    customMaskingColor: spec.customMaskingColor,
    customMaskingOpacity: spec.customMaskingOpacity,
    enableCustomLabelForLoginScreen: spec.enableCustomLabelForLoginScreen,
    customLabelTextForLoginScreen: spec.customLabelTextForLoginScreen,
    loginInstructionTitle: spec.loginInstructionTitle,
    loginInstruction: spec.loginInstruction,
    hideOneloginFooter: spec.hideOneloginFooter,
    mfaEnrollmentMessage: spec.mfaEnrollmentMessage,
    customSupportEnabled: spec.customSupportEnabled,
  }
}

/** Capture a live brand's writable fields - used both for rollback and as the base of a prior-state PUT. NEVER touches `master`. */
export function liveBrandToWriteInput(existing: LiveBrand): BrandWriteInput {
  return {
    name: existing.name ?? '',
    enabled: existing.enabled ?? true,
    customColor: existing.custom_color,
    customAccentColor: existing.custom_accent_color,
    customMaskingColor: existing.custom_masking_color,
    customMaskingOpacity: existing.custom_masking_opacity,
    enableCustomLabelForLoginScreen: existing.enable_custom_label_for_login_screen ?? false,
    customLabelTextForLoginScreen: existing.custom_label_text_for_login_screen,
    loginInstructionTitle: existing.login_instruction_title,
    loginInstruction: existing.login_instruction,
    hideOneloginFooter: existing.hide_onelogin_footer ?? false,
    mfaEnrollmentMessage: existing.mfa_enrollment_message,
    customSupportEnabled: existing.custom_support_enabled ?? false,
  }
}

/** Build the create/update request body from a writable-fields input. Never sends `master`. */
export function buildBrandBody(input: BrandWriteInput): Record<string, unknown> {
  return {
    name: input.name,
    enabled: input.enabled,
    custom_color: input.customColor ?? null,
    custom_accent_color: input.customAccentColor ?? null,
    custom_masking_color: input.customMaskingColor ?? null,
    custom_masking_opacity: input.customMaskingOpacity ?? null,
    enable_custom_label_for_login_screen: input.enableCustomLabelForLoginScreen,
    custom_label_text_for_login_screen: input.customLabelTextForLoginScreen ?? null,
    login_instruction_title: input.loginInstructionTitle ?? null,
    login_instruction: input.loginInstruction ?? null,
    hide_onelogin_footer: input.hideOneloginFooter,
    mfa_enrollment_message: input.mfaEnrollmentMessage ?? null,
    custom_support_enabled: input.customSupportEnabled,
  }
}
