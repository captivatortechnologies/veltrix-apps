import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Folders',
  'Secret Policies',
  'Groups',
  'Users',
  'IP Address Restrictions',
  'Sites',
  'Connection Managers',
  'Distributed Engine Configuration',
]

/**
 * Step-by-step connection guide for Delinea Secret Server, rendered with the
 * platform design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'account',
      label: '1. API user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Secret Server, use (or create) a dedicated <strong>API user</strong> whose permissions are
              scoped to what this app manages, and enable <strong>Webservices</strong> (Admin →
              Configuration → General → <em>Enable Webservices</em>). This app manages:
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
            <p>Store the API user as a Veltrix credential on the <strong>Connections</strong> page:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Secret Server API user
              </li>
              <li>
                <strong>Password</strong> → that user's password
              </li>
            </ul>
            <p>
              The app runs the OAuth2 <strong>password grant</strong> — it POSTs{' '}
              <code>grant_type=password</code> + the username/password to{' '}
              <code>&lt;base&gt;/oauth2/token</code>, then sends the returned access token as the{' '}
              <code>Authorization: Bearer</code> header.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '3. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection whose endpoint is your Secret Server{' '}
              <strong>base URL</strong> — on-prem <code>https://&lt;host&gt;/SecretServer</code>, cloud{' '}
              <code>https://&lt;tenant&gt;.secretservercloud.com</code> — and attach the credential. Use{' '}
              <strong>Test</strong> to verify the OAuth2 logon and API reachability (
              <code>GET /api/v1/folders?take=1</code>). Saving the connection registers a{' '}
              <code>delinea-secret-server</code> deploy target.
            </p>
            <p>
              On-prem Secret Server often presents a self-signed certificate — leave <em>Verify TLS
              certificate</em> off (the default) for it, and turn it on for cloud.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '4. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong> and pick a configuration type — grouped in the
              sidebar under <strong>Vault Structure</strong> (Folders, Secret Policies),{' '}
              <strong>Access &amp; Identity</strong> (Groups, Users, IP Address Restrictions) and{' '}
              <strong>Distributed Engines</strong> (Sites, Connection Managers, Distributed Engine
              Configuration) — author your configuration, and deploy through the pipeline. Drift detection
              and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
