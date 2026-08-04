// Shared helpers for the Password Safe Attributes config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// BeyondInsight models a two-tier taxonomy used to tag ManagedAccounts /
// ManagedSystems for Smart Rule scoping:
//   AttributeType   a category, e.g. "Environment", "Department" (Name only)
//   Attribute       a value within a type, e.g. "Production", "Finance"
//                   (ShortName, LongName, Description, optional parent attribute
//                   for a hierarchy within the type)
//
// This config type owns BOTH tiers from ONE item: it declares the value
// (shortName/longName/description) plus the NAME of the type it belongs to.
// The type is create-if-absent (shared across many attribute items, so it is
// NEVER deleted by rollback — deleting it would cascade-delete every attribute
// under it via DELETE /AttributeTypes/{id}, which this app deliberately never
// calls). Only the ATTRIBUTE VALUE this deploy created is undone on rollback.
//
// Assigning a value to a ManagedAccount/ManagedSystem (POST
// .../Attributes/{attributeId}) is a separate linking operation on those
// resources, not part of this config type.
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET  /AttributeTypes                          list categories
//   POST /AttributeTypes                           create a category { Name }
//   GET  /AttributeTypes/{attributeTypeID}/Attributes   list values under a category
//   POST /AttributeTypes/{attributeTypeID}/Attributes   create a value
//   DELETE /Attributes/{id}                        delete a value (used by rollback)

/** One attribute type (category) as returned by GET /AttributeTypes. */
export interface AttributeType {
  AttributeTypeID?: number | string
  Name?: string
  IsReadOnly?: boolean
  [key: string]: unknown
}

/** One attribute value as returned by GET /AttributeTypes/{id}/Attributes. */
export interface Attribute {
  AttributeID?: number | string
  AttributeTypeID?: number | string
  ParentAttributeID?: number | string | null
  ShortName?: string
  LongName?: string
  Description?: string | null
  [key: string]: unknown
}

/** The create body POSTed to /AttributeTypes/{attributeTypeID}/Attributes. */
export interface AttributeCreate {
  ShortName: string
  LongName: string
  Description?: string
  ParentAttributeID: null
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function listFrom<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: T[] }).Data
  }
  return []
}

/** Find a live attribute type by its (case-insensitive) name. */
export function findAttributeTypeByName(types: AttributeType[], name: string): AttributeType | null {
  const wanted = name.trim().toLowerCase()
  return types.find((t) => str(t.Name).toLowerCase() === wanted) ?? null
}

/** An attribute's identity, within one type, is its ShortName (case-folded). */
export function attributeIdentity(shortName: unknown): string {
  return str(shortName).toLowerCase()
}

/** Find a live attribute value by its (case-insensitive) ShortName. */
export function findAttributeByShortName(attributes: Attribute[], shortName: unknown): Attribute | null {
  const wanted = attributeIdentity(shortName)
  return attributes.find((a) => attributeIdentity(a.ShortName) === wanted) ?? null
}

/** Build the /AttributeTypes/{id}/Attributes create body from canvas fields. */
export function buildAttributeBody(fields: Record<string, unknown>): AttributeCreate {
  const body: AttributeCreate = {
    ShortName: str(fields.shortName),
    LongName: str(fields.longName),
    ParentAttributeID: null,
  }
  const description = str(fields.description)
  if (description) body.Description = description
  return body
}
