import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { findProgramId, str, policyWriteBody, readPolicyFromProgram } from './_shared'

/**
 * Deploy HackerOne Program Policy over the HackerOne API (v1).
 *
 *   resolve program: GET /me/programs               → handle → id
 *   capture prior:   GET /programs/{id}             → current policy text (for rollback)
 *   replace:         PUT /programs/{id}/policy      { data: { type: "program-policy", attributes: { policy } } }
 *
 * There is no create/delete here — a program always has SOME policy text, so
 * this always UPDATES an existing program. rollbackData records, per program,
 * the policy text captured immediately before the overwrite.
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Update Policy, Get Program)
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  previousPolicy: string | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for program-policy deployment' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const programsRes = await client.listPrograms()
  if (!programsRes.ok) {
    return {
      success: false,
      message: `Could not list HackerOne programs (GET /me/programs → HTTP ${programsRes.status}). Check the API credential.`,
    }
  }
  const programs = programsRes.items

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const handle = str(item.fields.program_handle)
    if (!handle) continue

    const programId = findProgramId(programs, handle)
    if (!programId) {
      failures.push(`program "${handle}": not found among the credential's programs (GET /me/programs)`)
      previous.push({ programHandle: handle, programId: null, previousPolicy: null })
      continue
    }

    let previousPolicy: string | null = null
    try {
      const current = await client.get(`/programs/${encodeURIComponent(programId)}`)
      if (current.ok) previousPolicy = readPolicyFromProgram(current.json)
    } catch {
      // Best-effort capture — a failed read just means rollback can't restore text.
    }

    const policy = str(item.fields.policy)
    const entry: RollbackEntry = { programHandle: handle, programId, previousPolicy }

    try {
      const res = await client.put(`/programs/${encodeURIComponent(programId)}/policy`, policyWriteBody(policy))
      const error = hackeroneWriteError(res)
      if (error) {
        failures.push(`update policy "${handle}": ${error}`)
        previous.push(entry)
        continue
      }
      previous.push(entry)
      applied.push(handle)
    } catch (error) {
      failures.push(`"${handle}": ${error instanceof Error ? error.message : 'Unknown error'}`)
      previous.push(entry)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Program-policy deploy applied ${applied.length} program(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied policy to ${applied.length} program(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
