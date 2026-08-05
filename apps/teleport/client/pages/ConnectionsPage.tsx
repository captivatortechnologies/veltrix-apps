import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Teleport - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Teleport's Proxy web API session login needs a
 * username + password + (usually) a TOTP second factor - three values, one
 * more than the manager's single secret field supports - so the "token" auth
 * mode's secret field carries a small JSON bundle pairing the password with
 * the base32 TOTP seed, the same "bundle multiple secrets into one credential
 * field" pattern apps/velociraptor uses for its api-client config. See
 * lib/teleport.ts's parseCredentialBundle for the exact shape.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Teleport"
      appId="teleport"
      componentType="teleport-cluster"
      usernameLabel="Teleport Username"
      usernameOptionalForToken={false}
      tokenLabel="Password + TOTP Secret (JSON)"
      tokenUsernamePlaceholder="e.g. veltrix-automation"
      endpointPlaceholder="e.g. teleport.example.com:443"
      endpointHelper="The Teleport Proxy address (host:port). Authentication is a local user's username/password, plus a TOTP second factor if the cluster enforces one - enter the secret as {&quot;password&quot;: &quot;...&quot;, &quot;totpSecret&quot;: &quot;&lt;base32 seed&gt;&quot;} (or a bare password if the cluster has no second factor)."
    />
  )
}
