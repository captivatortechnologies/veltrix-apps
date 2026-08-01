import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * SonarQube — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a SonarQube server
 * over HTTP(S) authenticated by an API token (no username);
 * `componentType="sonarqube-server"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="SonarQube"
      appId="sonarqube"
      componentType="sonarqube-server"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="e.g. https://sonarqube.example.com"
      endpointHelper="Your SonarQube server URL (https://host, or http://host:9000). Authentication uses a SonarQube token (My Account → Security); no username is required."
    />
  )
}
