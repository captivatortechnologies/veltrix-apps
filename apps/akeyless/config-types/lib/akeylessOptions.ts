import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, parseJson, type AkeylessClient } from '../../lib/akeyless'

/**
 * Live options provider shared by every akeyless config type. Powers
 * `remote-select` / `remote-multiselect` canvas fields via
 * GET /api/apps/akeyless/config-options. The platform resolves the
 * connection and runs this in-process, so it can call the Akeyless account
 * directly with the decrypted credential.
 *
 * Sources:
 *   - "auth-methods" - POST /list-auth-methods (https://docs.akeyless.io,
 *     operation `authMethodList`) - used by Roles' auth-method-association
 *     picker and by Gateway K8s Auth Config / Gateway Allowed Access's
 *     access-id picker. The option VALUE is the auth method's ACCESS ID
 *     (`auth_method_access_id`), not its name - `assoc-role-am` takes a name
 *     but `gateway-create-k8s-auth-config` / `gateway-create-allowed-access`
 *     both key off access-id, so the option label shows both.
 *   - "targets" - POST /target-list (operation `targetList`) - used by
 *     Dynamic Secret configs' and Rotated Secret configs' target-name
 *     picker. The option value is the target's NAME (what `target-name`
 *     expects on every producer/rotator create call).
 *
 * There is no list endpoint for Event Forwarders in the Akeyless API (only
 * create/update/get/delete per type) - Roles' `eventForwardersName` field is
 * therefore a plain tags field, not a remote picker (see roles/canvas.yaml).
 */
const akeylessOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  const built = buildAkeylessClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) throw new Error(built.error)
  const { client } = built

  if (ctx.source === 'auth-methods') return listAuthMethodOptions(client)
  if (ctx.source === 'targets') return listTargetOptions(client)
  return []
}

interface AuthMethodListItem {
  auth_method_name?: string
  auth_method_access_id?: string
}

async function listAuthMethodOptions(client: AkeylessClient): Promise<OptionItem[]> {
  const res = await client.request('/list-auth-methods')
  if (!res.ok) {
    throw new Error(`Failed to list Akeyless auth methods: ${akeylessErrorMessage(res)}`)
  }
  const parsed = parseJson<{ auth_methods?: AuthMethodListItem[] }>(res.body)
  return (parsed?.auth_methods ?? [])
    .filter((am): am is Required<AuthMethodListItem> => Boolean(am.auth_method_access_id && am.auth_method_name))
    .map((am) => ({
      value: am.auth_method_access_id,
      label: `${am.auth_method_name} (${am.auth_method_access_id})`,
    }))
}

interface TargetListItem {
  target_name?: string
  target_type?: string
}

async function listTargetOptions(client: AkeylessClient): Promise<OptionItem[]> {
  const res = await client.request('/target-list')
  if (!res.ok) {
    throw new Error(`Failed to list Akeyless targets: ${akeylessErrorMessage(res)}`)
  }
  const parsed = parseJson<{ targets?: TargetListItem[] }>(res.body)
  return (parsed?.targets ?? [])
    .filter((t): t is Required<TargetListItem> => Boolean(t.target_name))
    .map((t) => ({ value: t.target_name, label: t.target_type ? `${t.target_name} (${t.target_type})` : t.target_name }))
}

export default akeylessOptions
