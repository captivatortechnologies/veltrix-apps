import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: SonarQube is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[SonarQube] Running install hook for app "${appId}"`)
  console.log(
    '[SonarQube] No seeding required. Next steps: register a "sonarqube-server" component whose endpoint ' +
      'is your SonarQube URL (e.g. https://sonarqube.example.com), store a SonarQube token in a credential ' +
      '(API token field), and test the connection. Then author quality gates in the Configuration Canvas.',
  )
}
