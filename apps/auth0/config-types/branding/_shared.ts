// Shared helpers for the Auth0 Branding & Login Experience config type (deploy +
// rollback + drift). Three independent tenant-wide singletons, all folded into
// one canvas item because they together describe "what the login page looks
// like and behaves like":
//   GET/PATCH      /api/v2/branding                          logo, favicon, colors, font
//   GET/PATCH      /api/v2/prompts                            universal_login_experience, identifier_first, webauthn_platform_first_factor
//   GET/PUT/DELETE /api/v2/branding/templates/universal-login  Classic Universal Login custom HTML (raw text, not JSON)
//
// `branding` and `universal_login_body` fields are optional-omit: Auth0 validates
// colors/URLs by pattern, and an empty string is not a valid hex color, so a
// blank field means "don't touch this piece of live state" rather than "clear
// it" (mirrors the organizations config type's branding handling). The two
// Login Experience checkboxes and the experience select always have an explicit
// default, so they are always sent on every deploy.
//
// Verified against the official Auth0 Management API v2:
//   https://auth0.com/docs/api/management/v2/branding/patch-branding
//   https://auth0.com/docs/api/management/v2/prompts/patch-prompts
//   https://auth0.com/docs/api/management/v2/branding/put-universal-login

import { readOptionalString, readString } from '../../lib/fields'

export const UNIVERSAL_LOGIN_EXPERIENCES = new Set(['new', 'classic'])

/** The `/branding` singleton as returned by the Management API. */
export interface Auth0Branding {
  logo_url?: string
  favicon_url?: string
  colors?: { primary?: string; page_background?: string }
  font?: { url?: string }
  [key: string]: unknown
}

/** The `/prompts` singleton as returned by the Management API. */
export interface Auth0Prompts {
  universal_login_experience?: string
  identifier_first?: boolean
  webauthn_platform_first_factor?: boolean
  [key: string]: unknown
}

/** Build the `/branding` PATCH body — every key optional-omit (see file header). */
export function buildBrandingBody(fields: Record<string, unknown>): Auth0Branding {
  const body: Auth0Branding = {}
  const logoUrl = readOptionalString(fields.logo_url)
  if (logoUrl !== undefined) body.logo_url = logoUrl
  const faviconUrl = readOptionalString(fields.favicon_url)
  if (faviconUrl !== undefined) body.favicon_url = faviconUrl

  const primary = readOptionalString(fields.colors_primary)
  const pageBackground = readOptionalString(fields.colors_page_background)
  if (primary !== undefined || pageBackground !== undefined) {
    body.colors = {}
    if (primary !== undefined) body.colors.primary = primary
    if (pageBackground !== undefined) body.colors.page_background = pageBackground
  }

  const fontUrl = readOptionalString(fields.font_url)
  if (fontUrl !== undefined) body.font = { url: fontUrl }

  return body
}

/** Build the `/prompts` PATCH body — always fully declared (both booleans + the select have defaults). */
export function buildPromptsBody(fields: Record<string, unknown>): Auth0Prompts {
  return {
    universal_login_experience: readString(fields.universal_login_experience) || 'new',
    identifier_first: fields.identifier_first === true || fields.identifier_first === 'true',
    webauthn_platform_first_factor: fields.webauthn_platform_first_factor === true || fields.webauthn_platform_first_factor === 'true',
  }
}

/** The prior `/branding` state to restore on rollback — only the keys this type manages. */
export function snapshotBranding(live: Auth0Branding): Auth0Branding {
  const body: Auth0Branding = {}
  if (typeof live.logo_url === 'string') body.logo_url = live.logo_url
  if (typeof live.favicon_url === 'string') body.favicon_url = live.favicon_url
  if (live.colors) body.colors = { primary: live.colors.primary, page_background: live.colors.page_background }
  if (live.font?.url) body.font = { url: live.font.url }
  return body
}

/** The prior `/prompts` state to restore on rollback. */
export function snapshotPrompts(live: Auth0Prompts): Auth0Prompts {
  return {
    universal_login_experience: live.universal_login_experience ?? 'new',
    identifier_first: live.identifier_first === true,
    webauthn_platform_first_factor: live.webauthn_platform_first_factor === true,
  }
}
