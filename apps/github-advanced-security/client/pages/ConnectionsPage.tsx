import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * GitHub Advanced Security — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is a GitHub API endpoint (GitHub.com by default, or a GHES host)
 * authenticated by a token (fine-grained PAT, classic PAT, or GitHub App token);
 * `componentType="github-org"` so saving a connection also registers a deploy-target
 * component the config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="GitHub Advanced Security"
      appId="github-advanced-security"
      componentType="github-org"
      tokenLabel="Personal access token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="api.github.com"
      endpointHelper="The GitHub API host. Leave as api.github.com for GitHub.com; for GitHub Enterprise Server, enter your GHES host (the app reaches it at https://<host>/api/v3). Authentication uses a token with repository administration and code-security permissions."
    />
  )
}
