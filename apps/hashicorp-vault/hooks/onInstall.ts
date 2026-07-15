import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Vault is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[HashiCorp Vault] Running install hook for app "${appId}"`)
  console.log(
    '[HashiCorp Vault] No seeding required. Next steps: register a "vault-cluster" component whose ' +
      'hostname is the Vault URL (e.g. https://vault.example.com:8200), and store a Vault token in a ' +
      'credential\'s "API token" field. The token needs a policy granting sudo on sys/policies/acl, ' +
      'sys/auth, sys/mounts and sys/audit.',
  )
}
