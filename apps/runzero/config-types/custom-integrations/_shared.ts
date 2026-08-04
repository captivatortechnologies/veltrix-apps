// Shared helpers for the runZero Custom Integrations config type (deploy + rollback + drift + validate).
//
// A runZero custom integration is the registered identity (name/icon/description) a third-party
// asset-data feed imports under — the Starlark script that produces the data lives in a separate
// tool (runzero-custom-integrations / Custom Integration Scripts) and is NOT part of this API; this
// config type manages the registration only. The console API models it as (verified against
// runZeroInc/runzero-api runzero-api.yml — CustomIntegration / CustomIntegrationCreate /
// BaseCustomIntegration):
//   List:    GET    /account/custom-integrations                    → array of CustomIntegration
//   Create:  POST   /account/custom-integrations                    body CustomIntegrationCreate
//   Get:     GET    /account/custom-integrations/{id}
//   Update:  PATCH  /account/custom-integrations/{id}                body BaseCustomIntegration (partial)
//   Replace: PUT    /account/custom-integrations/{id}                body CustomIntegrationCreate (full)
//   Delete:  DELETE /account/custom-integrations/{id}
//
// This config type deploys with PATCH (partial update) rather than PUT (full replace-at-id) — both
// accept the same three fields (name/icon/description), so PATCH is the lower-risk choice.
//
// FLAG (scope): custom integrations are ACCOUNT-scoped resources — they live under /account, NOT
// /org (there is a separate READ-ONLY /org/custom-integrations, listing integrations already used
// by assets in that org — not used here). This config type requires the connection to carry an
// ACCOUNT-scoped runZero API key (the same flag as scan-templates); an Organization key gets
// 401/403 here.
//
// NAME CONSTRAINT: the spec's own field description requires the name to be "unique... without
// spaces" — validate.ts enforces the no-spaces rule as a hard error since it is cheap to catch
// client-side; uniqueness is left to the API's own 400 response.

/** One runZero CustomIntegration as returned by GET /account/custom-integrations. */
export interface RunzeroCustomIntegration {
  id?: string
  name?: string
  icon?: string
  description?: string
  [key: string]: unknown
}

/** The CustomIntegrationCreate / BaseCustomIntegration request body (create and update share this shape). */
export interface RunzeroCustomIntegrationBody {
  name: string
  icon?: string
  description: string
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single custom integration. */
export interface CustomIntegrationRollbackEntry {
  name: string
  integrationId: string | null
  existed: boolean
  prior: RunzeroCustomIntegration | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Find a live custom integration by name (case-insensitive — the stable identity for upsert/drift). */
export function findCustomIntegration(integrations: RunzeroCustomIntegration[], name: string): RunzeroCustomIntegration | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return integrations.find((i) => text(i.name).toLowerCase() === n) ?? null
}

/** Build the request body from canvas fields. `icon` is omitted entirely when blank. */
export function buildCustomIntegrationBody(fields: Record<string, unknown>): RunzeroCustomIntegrationBody {
  const body: RunzeroCustomIntegrationBody = {
    name: text(fields.name),
    description: text(fields.description),
  }
  const icon = text(fields.iconBase64)
  if (icon) body.icon = icon
  return body
}

/** Build a request body that restores a prior recorded custom integration (rollback). */
export function buildCustomIntegrationBodyFromPrior(prior: RunzeroCustomIntegration): RunzeroCustomIntegrationBody {
  const body: RunzeroCustomIntegrationBody = {
    name: text(prior.name),
    description: text(prior.description),
  }
  if (prior.icon) body.icon = prior.icon
  return body
}
