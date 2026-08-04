// Shared helpers for the HackerOne Program Policy config type (deploy + rollback
// + drift). Pure + network-free so they can be unit-tested.
//
// A program's policy is a single writable attribute (`policy`, Markdown text) on
// the `program` resource, replaced wholesale by PUT — there is no separate
// "policy" JSON:API type distinct from the program it belongs to for reads (the
// current text is read off `GET /programs/{id}`), only for the write envelope.
//   Confirmed: https://api.hackerone.com/customer-resources/ (Update Policy)
//     PUT /programs/{id}/policy
//       { data: { type: "program-policy", attributes: { policy } } }
//     Response: the updated `program` resource (attributes.policy).

export { str, findProgramId, groupItemsByProgram, type ProgramResource } from '../../lib/programScopes'

/** JSON:API resource `type` HackerOne expects for a policy update. */
export const PROGRAM_POLICY_TYPE = 'program-policy'

/**
 * JSON:API write document for replacing a program's policy:
 *   { data: { type: "program-policy", attributes: { policy } } }
 */
export function policyWriteBody(policy: string): { data: { type: string; attributes: { policy: string } } } {
  return { data: { type: PROGRAM_POLICY_TYPE, attributes: { policy } } }
}

/** Read a program's current policy text off a `GET /programs/{id}` response body. */
export function readPolicyFromProgram(json: unknown): string | null {
  const doc = json as { data?: { attributes?: { policy?: string } } } | null
  const policy = doc?.data?.attributes?.policy
  return typeof policy === 'string' ? policy : null
}
