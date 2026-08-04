import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listProfiles, PRIMARY } from '../../lib/thehiveApi'
import {
  buildProfileCreateBody,
  buildProfileUpdateBody,
  findProfile,
  profileId,
  profilesFromList,
  type Profile,
} from './_shared'

/**
 * Deploy TheHive profiles over the REST API:
 *   read (rollback): list profiles              → find the live one by name
 *   create:          POST  /api/v1/profile        with InputProfile
 *   update:          PATCH /api/v1/profile/<id>    with InputUpdateProfile (no name)
 *
 * The name is the stable identity used to upsert. rollbackData records, per
 * profile, the prior body (null when it did not exist) AND the id — so rollback
 * can restore the prior permission set or delete the one we created.
 *
 * v5 paths are primary (see lib/thehiveApi.ts API_VERSION seam). Verify against a
 * live TheHive (see README, v4 vs v5). TheHive rejects writes to its five
 * immutable built-in profiles (everything but `analyst`) — validate.ts warns,
 * but a live rejection still surfaces here as a deploy failure.
 */
async function listAll(base: string, headers: Record<string, string>): Promise<Profile[]> {
  try {
    return profilesFromList(await listProfiles<Profile>(base, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for profile deployment' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; profileId: string | null; profile: Profile | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findProfile(live, name)
      const existingId = profileId(existing)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PRIMARY.profileById(existingId)}`, headers, buildProfileUpdateBody(item.fields))
        previous.push({ name, profileId: existingId, profile: existing })
      } else {
        const created = await sendJson<Profile>('POST', `${base}${PRIMARY.profile}`, headers, buildProfileCreateBody(item.fields))
        previous.push({ name, profileId: profileId(created), profile: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} profile(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Profile deploy failed after ${applied.length} profile(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
