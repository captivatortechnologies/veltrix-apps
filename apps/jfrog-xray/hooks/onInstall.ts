import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: JFrog Xray is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[JFrog Xray] Running install hook for app "${appId}"`)
  console.log(
    '[JFrog Xray] No seeding required. Next steps: generate an Access Token in the JFrog Platform ' +
      '(Administration > User Management > Access Tokens) scoped with the Xray "Manage Policies" and ' +
      '"Read Policies" permissions; store it in a credential\'s "Access token" field; and register a ' +
      '"jfrog-xray-instance" component whose hostname is your JFrog Platform host (e.g. mycompany.jfrog.io).',
  )
}
