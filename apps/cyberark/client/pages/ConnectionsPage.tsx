import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * CyberArk PAM — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. CyberArk PVWA authenticates with a manager account
 * username + password via the logon flow — use the "Username / Password" auth
 * method. The connection endpoint is the PVWA web server host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="CyberArk Privileged Access Manager"
      appId="cyberark"
      usernameLabel="Username"
      passwordUsernamePlaceholder="PVWA manager username"
      tokenLabel="API token (not used)"
      endpointPlaceholder="e.g. pvwa.example.com"
      endpointHelper="PVWA web server host — the app targets https://<host>/PasswordVault/API. Use the Username / Password auth method; set the logon method (CyberArk / LDAP / RADIUS) in app settings."
    />
  )
}
