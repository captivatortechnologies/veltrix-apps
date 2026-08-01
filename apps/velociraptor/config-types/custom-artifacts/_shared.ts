// Shared helpers for the Velociraptor Custom Artifacts config type
// (deploy + rollback + drift + health). VQL runs over the gRPC API (mutual TLS);
// see lib/velociraptorApi.ts for the transport seam.
//
// VERIFY against a live Velociraptor server: artifact_set / artifact_delete /
// artifact_definitions column shapes (flagged in lib/velociraptorApi.ts).

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  readArtifactDefinition,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

/** Valid Velociraptor artifact types (also NOTEBOOK/INTERNAL exist; not authored here). */
export const ARTIFACT_TYPES = new Set(['CLIENT', 'SERVER', 'CLIENT_EVENT', 'SERVER_EVENT'])

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

/** The top-level `name:` declared inside an artifact definition YAML, if any. */
export function extractYamlName(definition: string): string | null {
  const match = /^name\s*:\s*["']?([^"'\r\n#]+)["']?\s*$/m.exec(definition)
  return match ? match[1].trim() : null
}

/** The top-level `type:` declared inside an artifact definition YAML, if any. */
export function extractYamlType(definition: string): string | null {
  const match = /^type\s*:\s*["']?([A-Za-z_]+)["']?\s*$/m.exec(definition)
  return match ? match[1].trim().toUpperCase() : null
}

/**
 * Lightweight structural sanity for an artifact definition (no YAML dependency at
 * runtime): must be non-empty, must declare a top-level `name:`, and must not use
 * hard tabs for indentation (YAML forbids tabs). Deep schema validation is left to
 * the server, which rejects a malformed artifact at artifact_set time.
 */
export function looksLikeArtifactYaml(definition: string): { ok: boolean; reason?: string } {
  const text = definition ?? ''
  if (!text.trim()) return { ok: false, reason: 'definition is empty' }
  if (/^\t/m.test(text)) return { ok: false, reason: 'definition uses tab indentation (YAML requires spaces)' }
  if (!extractYamlName(text)) return { ok: false, reason: 'definition has no top-level "name:" key' }
  return { ok: true }
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
