import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Safes', 'Safe members', 'Accounts']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'account',
      label: '1. Manager account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In CyberArk, provision a dedicated <strong>manager / service account</strong> whose Vault
              authorizations are scoped to what this app manages. It authenticates through the PVWA{' '}
              <strong>logon flow</strong> (username + password):
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the manager account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the manager account username
              </li>
              <li>
                <strong>Password</strong> → the manager account password
              </li>
            </ul>
            <p>
              The app calls <code>POST /PasswordVault/API/auth/&lt;method&gt;/Logon</code>, then sends
              the returned session token as the <code>Authorization</code> header. Set the logon method
              (<strong>CyberArk</strong>, <strong>LDAP</strong> or <strong>RADIUS</strong>) in the app
              settings.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>cyberark-pvwa</strong> component whose hostname is your PVWA web
              server (e.g. <code>pvwa.example.com</code>) and attach the credential. The app targets{' '}
              <code>https://&lt;host&gt;/PasswordVault/API</code>.
            </p>
            <p>
              PVWA is served over HTTPS and often presents an internal certificate — the platform host
              must trust the PVWA certificate.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
