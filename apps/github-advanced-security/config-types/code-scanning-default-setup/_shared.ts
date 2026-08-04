// Shared helpers for the Code Scanning Default Setup config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the FULL CodeQL default-setup configuration for one
// repository (`owner/repo`) — state, query suite, languages, threat model and
// runner selection. Complements `repo-security-config`'s boolean
// `code_scanning_default_setup` toggle (which only sends `{ state }`) with the
// rest of the surface GitHub exposes on the same endpoint.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration

/** The languages GitHub's default setup can analyze (fixed enum per docs). */
export const CODE_SCANNING_LANGUAGES = [
  'actions',
  'c-cpp',
  'csharp',
  'go',
  'java-kotlin',
  'javascript-typescript',
  'python',
  'ruby',
  'swift',
] as const

export const CODE_SCANNING_STATES = ['configured', 'not-configured'] as const
export const QUERY_SUITES = ['default', 'extended'] as const
export const THREAT_MODELS = ['remote', 'remote_and_local'] as const
export const RUNNER_TYPES = ['', 'standard', 'labeled'] as const

/** The desired state one canvas item declares. */
export interface DefaultSetupDesired {
  repository: string
  state: string
  querySuite: string
  languages: string[]
  threatModel: string
  runnerType: string
  runnerLabel: string
}

/** GET /repos/{owner}/{repo}/code-scanning/default-setup — the full response shape. */
export interface DefaultSetupConfig {
  state?: string
  languages?: string[]
  runner_type?: string | null
  runner_label?: string | null
  query_suite?: string
  threat_model?: string
  schedule?: string | null
  updated_at?: string | null
}

/** `owner/repo` → { owner, repo }, or null when the value is not a valid full name. */
export function parseRepository(value: unknown): { owner: string; repo: string } | null {
  const raw = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return null
  const parts = raw.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts.map((p) => p.trim())
  if (!owner || !repo) return null
  return { owner, repo }
}

/** Read a tags/array field (real array, or a comma/newline separated string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): DefaultSetupDesired {
  return {
    repository: String(fields.repository ?? '').trim(),
    state: (String(fields.state ?? 'not-configured').trim().toLowerCase() || 'not-configured'),
    querySuite: (String(fields.query_suite ?? 'default').trim().toLowerCase() || 'default'),
    languages: toStringArray(fields.languages),
    threatModel: (String(fields.threat_model ?? 'remote').trim().toLowerCase() || 'remote'),
    runnerType: String(fields.runner_type ?? '').trim().toLowerCase(),
    runnerLabel: String(fields.runner_label ?? '').trim(),
  }
}

/**
 * Build the PATCH body. `runner_type`/`runner_label` are only sent when a
 * labeled runner is chosen; `languages` is only sent when the operator picked
 * specific languages (empty → GitHub auto-detects every supported language).
 */
export function buildDefaultSetupPatch(desired: DefaultSetupDesired): Record<string, unknown> {
  const body: Record<string, unknown> = {
    state: desired.state,
    query_suite: desired.querySuite,
    threat_model: desired.threatModel,
  }
  if (desired.languages.length > 0) body.languages = desired.languages
  if (desired.runnerType === 'labeled') {
    body.runner_type = 'labeled'
    body.runner_label = desired.runnerLabel
  } else if (desired.runnerType === 'standard') {
    body.runner_type = 'standard'
  }
  return body
}

/** Reconstruct the PATCH body that restores a prior default-setup configuration. */
export function restoreBody(prior: DefaultSetupConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.state !== undefined) body.state = prior.state
  if (prior.query_suite !== undefined) body.query_suite = prior.query_suite
  if (prior.threat_model !== undefined) body.threat_model = prior.threat_model
  if (Array.isArray(prior.languages) && prior.languages.length > 0) body.languages = prior.languages
  if (prior.runner_type) {
    body.runner_type = prior.runner_type
    if (prior.runner_label) body.runner_label = prior.runner_label
  }
  return body
}

/** Deterministic JSON for comparing the `languages` array regardless of order. */
export function sortedLanguages(languages: string[] | undefined): string {
  return JSON.stringify([...(languages ?? [])].sort())
}
