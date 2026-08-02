import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cisco ISE — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * ISE's ERS API authenticates with plain HTTP Basic (an ISE administrator's
 * username + password) — no separate token concept — so both auth methods map
 * to the same username/password pair; the connection endpoint is the PAN/admin
 * node's hostname and ERS port. Saving a connection also registers the
 * `cisco-ise` deploy target, so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cisco ISE"
      appId="cisco-ise"
      componentType="cisco-ise"
      usernameLabel="ERS username"
      usernameOptionalForToken={false}
      tokenLabel="Password"
      tokenUsernamePlaceholder="the ISE administrator username"
      passwordUsernamePlaceholder="the ISE administrator username"
      endpointPlaceholder="e.g. ise-pan.example.com:9060"
      endpointHelper="The ISE PAN/admin node hostname and ERS port (fixed at 9060 unless proxied). Enable ERS first under Administration > System > Settings > API Settings."
    />
  )
}
