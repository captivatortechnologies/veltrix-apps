// Shared helpers for the authentik Scope (Property) Mappings config type
// (deploy + rollback + drift). Shapes follow the authentik Core API
// `ScopeMapping` / `ScopeMappingRequest` / `PatchedScopeMappingRequest`
// schemas — see lib/authentikApi.ts for citations.
//
// IDENTITY: the API path key is a server-assigned UUID (`pm_uuid`,
// `/propertymappings/provider/scope/{pm_uuid}/`) — this config type upserts by
// NAME (list `?name=` → match → PATCH/POST).

export interface AuthentikScopeMapping {
  pk?: string
  name?: string
  scope_name?: string
  description?: string
  expression?: string
  [key: string]: unknown
}

export interface ManagedScopeMappingFields {
  name: string
  scopeName: string
  description: string
  expression: string
}

export function readManagedFields(fields: Record<string, unknown>): ManagedScopeMappingFields {
  return {
    name: String(fields.name ?? '').trim(),
    scopeName: String(fields.scope_name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    expression: String(fields.expression ?? ''),
  }
}

function buildManagedBody(managed: ManagedScopeMappingFields): Record<string, unknown> {
  return {
    name: managed.name,
    scope_name: managed.scopeName,
    description: managed.description,
    expression: managed.expression,
  }
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedScopeMappingFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

export function snapshotManagedFields(mapping: AuthentikScopeMapping): ManagedScopeMappingFields {
  return {
    name: String(mapping.name ?? '').trim(),
    scopeName: String(mapping.scope_name ?? '').trim(),
    description: String(mapping.description ?? '').trim(),
    expression: String(mapping.expression ?? ''),
  }
}

export function sameManagedFields(expected: ManagedScopeMappingFields, actual: ManagedScopeMappingFields): boolean {
  return (
    expected.name === actual.name &&
    expected.scopeName === actual.scopeName &&
    expected.description === actual.description &&
    expected.expression === actual.expression
  )
}
