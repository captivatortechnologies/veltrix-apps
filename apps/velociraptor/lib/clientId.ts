// Shared Velociraptor client-id format check.
//
// Velociraptor client ids are "C." followed by a lowercase hex string derived
// from the client's public key (commonly 16 hex characters, e.g.
// "C.1a2b3c4d5e6f7890"). This format applies to the Client Labels config type's
// authored member list (explicit client ids an operator pins a label to).
// Centralised here so the pattern is defined once, mirroring lib/artifactName.ts.
//
// VERIFY: the exact hex length is not authoritatively documented — this accepts
// any length in a practical range rather than pinning to 16, so a legitimately
// shorter/longer id (e.g. a future id scheme) is not falsely rejected.

export const CLIENT_ID_RE = /^C\.[0-9a-fA-F]{4,40}$/

/** True when `id` matches Velociraptor's "C.<hex>" client-id format. */
export function validClientId(id: string): boolean {
  return CLIENT_ID_RE.test(id.trim())
}
