import type { FormParamValue } from '../../lib/sonarqubeApi'

// Shared helpers for the SonarQube ALM Settings config type (validate + deploy + rollback +
// drift). Pure and network-free so validate.ts and the tests can use it.
//
// An ALM Setting is one instance-level "DevOps Platform Integration" — the named connection
// to GitHub / GitLab / Bitbucket Server / Bitbucket Cloud / Azure DevOps that backs pull
// request decoration and project import — addressed by a globally-unique `key`. Applied over
// the SonarQube Web API (/api/alm_settings, since 8.1).
//
// OUT OF SCOPE, deliberately:
//   - per-project repository bindings (set_github_binding, set_gitlab_binding,
//     set_bitbucket_binding, set_bitbucketcloud_binding, set_azure_binding) — a different,
//     PROJECT-scoped surface. This type manages only the instance-level connection settings
//     themselves, never a project's binding to one of them.
//   - the project-IMPORT actions (import_github_project, import_bitbucketserver_project,
//     import_gitlab_project, import_azure_project) — one-shot actions that CREATE a brand
//     new SonarQube project. Not reconcilable declarative state, and marked
//     DEPRECATED-since=10.5 in the live API besides.
//
// Verified live against a running SonarQube instance's own `api/webservices` reflection
// endpoints (api/webservices/list?include_internals=true, api/webservices/response_example).
//
// create_<almType> requires ALL fields, including secrets (SonarQube requires secrets at
// creation time). update_<almType> makes secret fields OPTIONAL — "Optional new value for
// ..." — omitting one leaves the current stored value unchanged (the exact pattern this
// app's webhook secret uses), but STILL requires the non-secret identity fields (url /
// appId / clientId / workspace, as applicable to the provider).
//
// SECRETS ARE NEVER RETURNED BY ANY READ ACTION — confirmed via a live response_example
// fetch for list_definitions: the `github` entry omits clientSecret/privateKey/webhookSecret
// entirely even though they were surely set on creation. `azure`/`bitbucket`/`gitlab`
// entries carry `{key, url}` (the personalAccessToken is never returned); `bitbucketcloud`
// entries carry `{key, clientId, workspace}` (no url, no clientSecret).

/** The 5 DevOps platforms SonarQube's ALM Settings API supports. */
export const ALM_TYPES = new Set(['github', 'gitlab', 'bitbucket', 'bitbucketcloud', 'azure'])
export type AlmType = 'github' | 'gitlab' | 'bitbucket' | 'bitbucketcloud' | 'azure'

/** A definition as returned by /api/alm_settings/list_definitions. Never carries a secret. */
export interface AlmDefinition {
  key?: string
  url?: string
  appId?: string
  clientId?: string
  workspace?: string
}

/** An AlmDefinition tagged with the provider array it was found under. */
export type FlatDefinition = AlmDefinition & { almType: string }

/**
 * Unwrap SonarQube's list_definitions envelope — VERIFIED LIVE SHAPE:
 *   { github: [...], azure: [...], bitbucket: [...], gitlab: [...], bitbucketcloud: [...] }
 * into a flat map keyed by setting `key`. Setting keys are globally unique across all 5
 * provider types (SonarQube enforces this), so a flat map is sufficient to reconcile
 * against and simpler than a nested almType → key structure. Each entry is tagged with the
 * almType it was found under. Defensive against a missing or non-array property for any of
 * the 5 known types (treated as empty) and against non-object entries.
 */
export function definitionsFromListResponse(payload: unknown): Map<string, FlatDefinition> {
  const map = new Map<string, FlatDefinition>()
  if (!payload || typeof payload !== 'object') return map

  const obj = payload as Record<string, unknown>
  for (const almType of ALM_TYPES) {
    const list = obj[almType]
    if (!Array.isArray(list)) continue

    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const rec = entry as Record<string, unknown>
      const key = String(rec.key ?? '').trim()
      if (!key) continue

      map.set(key, {
        almType,
        key,
        url: typeof rec.url === 'string' ? rec.url : undefined,
        appId: typeof rec.appId === 'string' ? rec.appId : undefined,
        clientId: typeof rec.clientId === 'string' ? rec.clientId : undefined,
        workspace: typeof rec.workspace === 'string' ? rec.workspace : undefined,
      })
    }
  }
  return map
}

export function createAction(almType: string): string {
  return `create_${almType}`
}
export function updateAction(almType: string): string {
  return `update_${almType}`
}

/**
 * Fields SonarQube requires when CREATING a setting of this type (secrets included —
 * create_* requires them up front). Referenced by validate.ts for the "blank on a brand
 * new key" warning, and mirrors the live create_* parameter lists exactly.
 */
export const REQUIRED_ON_CREATE: Record<string, string[]> = {
  github: ['url', 'appId', 'clientId', 'clientSecret', 'privateKey'],
  gitlab: ['url', 'personalAccessToken'],
  bitbucket: ['url', 'personalAccessToken'],
  bitbucketcloud: ['clientId', 'clientSecret', 'workspace'],
  azure: ['url', 'personalAccessToken'],
}

/** Human labels for the field keys above, for validate/deploy messages. */
export const FIELD_LABELS: Record<string, string> = {
  url: 'URL',
  appId: 'App ID',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  privateKey: 'Private key',
  personalAccessToken: 'Personal access token',
  workspace: 'Workspace',
}

/** The raw canvas field values a deploy needs, gathered once per item. */
export interface SettingFields {
  key: string
  url: string
  personalAccessToken: string
  appId: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret: string
  workspace: string
}

/**
 * Build the create_<almType> params. All type-relevant fields are sent (including
 * secrets, which SonarQube requires at creation); webhookSecret is optional even at
 * creation for github. Blank values are dropped by postForm's own form-encoder.
 */
export function createParams(almType: string, f: SettingFields): Record<string, FormParamValue> {
  switch (almType) {
    case 'github':
      return {
        key: f.key,
        url: f.url,
        appId: f.appId,
        clientId: f.clientId,
        clientSecret: f.clientSecret,
        privateKey: f.privateKey,
        webhookSecret: f.webhookSecret || undefined,
      }
    case 'bitbucketcloud':
      return { key: f.key, clientId: f.clientId, clientSecret: f.clientSecret, workspace: f.workspace }
    default: // gitlab, bitbucket, azure
      return { key: f.key, url: f.url, personalAccessToken: f.personalAccessToken }
  }
}

/**
 * Build the update_<almType> params. Non-secret identity fields (url / appId / clientId /
 * workspace) are ALWAYS resent — update_* still requires them. Secret fields are sent only
 * when non-blank, so a blank secret leaves the currently-stored value unchanged.
 */
export function updateParams(almType: string, f: SettingFields): Record<string, FormParamValue> {
  switch (almType) {
    case 'github':
      return {
        key: f.key,
        url: f.url,
        appId: f.appId,
        clientId: f.clientId,
        clientSecret: f.clientSecret || undefined,
        privateKey: f.privateKey || undefined,
        webhookSecret: f.webhookSecret || undefined,
      }
    case 'bitbucketcloud':
      return { key: f.key, clientId: f.clientId, workspace: f.workspace, clientSecret: f.clientSecret || undefined }
    default: // gitlab, bitbucket, azure
      return { key: f.key, url: f.url, personalAccessToken: f.personalAccessToken || undefined }
  }
}

/** The non-secret identity fields rollback can recover for a given ALM type (never a secret). */
export interface RestoreFields {
  key: string
  url?: string
  appId?: string
  clientId?: string
  workspace?: string
}

/**
 * Build the update_<almType> params used to restore a PRE-EXISTING setting's non-secret
 * identity fields on rollback. Deliberately NEVER references a secret field key — secrets
 * cannot be restored (SonarQube never returns them), so rollback for a setting that already
 * existed can only put back what it read back: url/appId/clientId (github/gitlab/bitbucket/
 * azure) or clientId/workspace (bitbucketcloud, which has no url).
 */
export function restoreParams(almType: string, f: RestoreFields): Record<string, FormParamValue> {
  switch (almType) {
    case 'github':
      return { key: f.key, url: f.url, appId: f.appId, clientId: f.clientId }
    case 'bitbucketcloud':
      return { key: f.key, clientId: f.clientId, workspace: f.workspace }
    default: // gitlab, bitbucket, azure
      return { key: f.key, url: f.url }
  }
}
