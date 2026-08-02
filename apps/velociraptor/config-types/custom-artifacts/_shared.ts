// Shared helpers for the Velociraptor Custom Artifacts config type
// (deploy + rollback + drift + health). VQL runs over the gRPC API (mutual TLS);
// see lib/velociraptorApi.ts for the transport seam.
//
// The artifact definition YAML is parsed + schema-checked here (validateArtifactDefinition,
// via the `yaml` package) — a syntax error or a malformed name/type/sources/parameters
// shape is now caught at validate time. Deep VQL compilation of the sources' queries is
// still authoritative on the server, at artifact_set() time.
//
// VERIFY against a live Velociraptor server: artifact_set / artifact_delete /
// artifact_definitions column shapes (flagged in lib/velociraptorApi.ts).

import { parse as parseYaml } from 'yaml'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  readArtifactDefinition,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'
import { validArtifactName } from '../../lib/artifactName'

/** Valid types for the authored item's `type` field (also NOTEBOOK/INTERNAL exist
 *  as artifact kinds, but are not authored as a canvas item here). */
export const ARTIFACT_TYPES = new Set(['CLIENT', 'SERVER', 'CLIENT_EVENT', 'SERVER_EVENT'])

/** Every valid Velociraptor artifact `type:`, as it may legitimately appear
 *  inside a definition's YAML (broader than ARTIFACT_TYPES, which is only the
 *  authored item-type selector). */
export const ARTIFACT_YAML_TYPES = new Set(['CLIENT', 'SERVER', 'CLIENT_EVENT', 'SERVER_EVENT', 'NOTEBOOK', 'INTERNAL'])

/** One artifact definition row as returned by artifact_definitions(). VERIFY columns. */
export interface Artifact {
  name?: string
  type?: string
  description?: string
  /** The raw YAML source; column name varies (raw/definition) — read via readArtifactDefinition. */
  raw?: string
  [key: string]: unknown
}

/** Read the VQL timeout (seconds) from installation settings, defaulting to 30s. */
export function vqlTimeoutMs(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.['vql_timeout_seconds']
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
}

/**
 * Resolve the api-client config from the connection and build a Velociraptor
 * client (gRPC/mTLS). Throws when the credential is missing the mTLS material.
 */
export async function buildClient(
  component: ComponentRef,
  credential: CredentialRef | null | undefined,
  connectivity: ConnectivityRef | null | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<VelociraptorClient> {
  const config = resolveApiClientConfig(credential, component, connectivity)
  return createVelociraptorClient(config, { timeoutMs: vqlTimeoutMs(settings) })
}

/** Result of parsing + schema-checking an artifact definition YAML. */
export interface ArtifactDefinitionCheck {
  /** False when the definition is unusable: a YAML syntax error, a non-mapping
   *  root, or a malformed name/type/sources/parameters shape. */
  ok: boolean
  /** Present when ok is false — the reason, for the INVALID_DEFINITION error. */
  reason?: string
  /** The definition's own top-level `name:`, once far enough to read it. */
  name: string | null
  /** The definition's own top-level `type:` (upper-cased), once far enough to read it. */
  type: string | null
  /** Soft issues that do not block deploy, e.g. "this artifact collects nothing". */
  warnings: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse an artifact definition as real YAML (via the `yaml` package, YAML 1.2)
 * and check it against Velociraptor's artifact schema shape:
 *   - the document must parse (a syntax error is a hard failure)
 *   - the root must be a mapping (not a scalar or a list)
 *   - `name:` is required, a string, and dotted-alphanumeric (ARTIFACT_NAME_RE)
 *   - `type:`, if present, must be one of ARTIFACT_YAML_TYPES
 *   - `sources:`, if present, must be a non-empty list; each source a mapping
 *     with a non-empty `query` string, or a non-empty `queries` list of strings
 *   - `parameters:`, if present, must be a list of mappings each with a string `name`
 *   - when there is no `sources:` and no top-level `query:`, a (non-blocking)
 *     warning notes the artifact collects nothing
 *
 * This replaces the former regex-based structural sanity check — a YAML syntax
 * error is now caught here, before deploy, instead of surfacing opaquely at
 * artifact_set() time. Deep VQL compilation of the sources' queries remains
 * authoritative on the server, at artifact_set().
 */
export function validateArtifactDefinition(definition: string): ArtifactDefinitionCheck {
  const warnings: string[] = []
  const text = definition ?? ''
  if (!text.trim()) return { ok: false, reason: 'definition is empty', name: null, type: null, warnings }

  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { ok: false, reason: `YAML syntax error — ${message}`, name: null, type: null, warnings }
  }

  if (!isPlainObject(doc)) {
    return {
      ok: false,
      reason: 'definition must be a YAML mapping with top-level name:/type:/sources: keys, not a list or scalar',
      name: null,
      type: null,
      warnings,
    }
  }

  const rawName = doc['name']
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return { ok: false, reason: 'definition has no top-level "name:" key', name: null, type: null, warnings }
  }
  const name = rawName.trim()
  if (!validArtifactName(name)) {
    return {
      ok: false,
      reason: `definition name "${name}" must be dotted alphanumeric, e.g. Custom.Windows.Detection.Foo`,
      name,
      type: null,
      warnings,
    }
  }

  let type: string | null = null
  if (doc['type'] !== undefined) {
    const rawType = doc['type']
    if (typeof rawType !== 'string' || !rawType.trim()) {
      return { ok: false, reason: 'definition "type:" must be a string', name, type: null, warnings }
    }
    type = rawType.trim().toUpperCase()
    if (!ARTIFACT_YAML_TYPES.has(type)) {
      return {
        ok: false,
        reason: `definition type "${rawType}" must be one of ${[...ARTIFACT_YAML_TYPES].join(', ')}`,
        name,
        type,
        warnings,
      }
    }
  }

  let hasSources = false
  if (doc['sources'] !== undefined) {
    const sources = doc['sources']
    if (!Array.isArray(sources) || sources.length === 0) {
      return { ok: false, reason: 'definition "sources:" must be a non-empty list', name, type, warnings }
    }
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]
      if (!isPlainObject(source)) {
        return { ok: false, reason: `definition sources[${i}] must be a mapping`, name, type, warnings }
      }
      const query = source['query']
      const queries = source['queries']
      const hasQuery = typeof query === 'string' && query.trim().length > 0
      const hasQueries =
        Array.isArray(queries) && queries.length > 0 && queries.every((q) => typeof q === 'string' && q.trim().length > 0)
      if (!hasQuery && !hasQueries) {
        return {
          ok: false,
          reason: `definition sources[${i}] must have a non-empty "query" or a non-empty "queries" list of strings`,
          name,
          type,
          warnings,
        }
      }
    }
    hasSources = true
  }

  const topLevelQuery = doc['query']
  const hasTopLevelQuery = typeof topLevelQuery === 'string' && topLevelQuery.trim().length > 0
  if (!hasSources && !hasTopLevelQuery) {
    warnings.push('definition declares no "sources:" (and no top-level "query:") — this artifact collects nothing')
  }

  if (doc['parameters'] !== undefined) {
    const parameters = doc['parameters']
    if (!Array.isArray(parameters)) {
      return { ok: false, reason: 'definition "parameters:" must be a list', name, type, warnings }
    }
    for (let i = 0; i < parameters.length; i++) {
      const param = parameters[i]
      if (!isPlainObject(param) || typeof param['name'] !== 'string' || !(param['name'] as string).trim()) {
        return {
          ok: false,
          reason: `definition parameters[${i}] must be a mapping with a string "name"`,
          name,
          type,
          warnings,
        }
      }
    }
  }

  return { ok: true, name, type, warnings }
}

/** Normalize a definition for equality comparison (line-ending + trailing whitespace only). */
export function normalizeDefinition(definition: string): string {
  return String(definition ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
    .trim()
}

/** Unwrap artifact_definitions() rows into a flat list, tolerant of envelope shapes. */
export function artifactsFromRows(rows: VqlRow[]): Artifact[] {
  return rows.map((row) => row as Artifact)
}

/** Find a live artifact by exact name. */
export function findArtifact(artifacts: Artifact[], name: string): Artifact | null {
  const n = name.trim()
  if (!n) return null
  return artifacts.find((a) => String(a.name ?? '').trim() === n) ?? null
}

/** The raw definition source of a matched artifact row (column-name tolerant). */
export function definitionOf(artifact: Artifact | null): string {
  return readArtifactDefinition(artifact as VqlRow | null)
}
