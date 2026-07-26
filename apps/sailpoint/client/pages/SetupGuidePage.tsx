import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// The transform endpoints require the ISC transform scopes, and the PAT should
// be generated from an ORG_ADMIN user (config endpoints require ORG_ADMIN).
const REQUIRED_SCOPES = ['idn:transform:manage', 'idn:transform:read']

/**
 * Step-by-step connection guide for the SailPoint Identity Security Cloud app,
 * rendered with the platform design-system components from
 * @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the built-in platform
 * screens use, themed to the app's brand color. ISC authenticates via OAuth2
 * client credentials (a Personal Access Token works).
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'tenant',
      label: '1. Tenant',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Find your ISC <strong>org name</strong> — the subdomain of your tenant. The API is
              reached at <code>https://&#123;org&#125;.api.identitynow.com</code>.
            </p>
            <ul>
              <li>
                If your admin console is <code>acme.identitynow.com</code>, your org name is{' '}
                <strong>acme</strong>.
              </li>
              <li>
                Set this as the app's <strong>Tenant</strong> setting (or provide a full{' '}
                <strong>API URL</strong> override for non-standard hosts).
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'pat',
      label: '2. Personal Access Token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Signed in as an <strong>ORG_ADMIN</strong> user, go to{' '}
              <strong>Preferences &gt; Personal Access Tokens</strong> and create a new token with
              these scopes:
            </p>
            <div>
              {REQUIRED_SCOPES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              ISC shows the <strong>Client ID</strong> and <strong>Client Secret</strong> once — copy
              both. (A standalone API-management OAuth client with the same scopes works too.)
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '3. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Client ID
              </li>
              <li>
                <strong>Password</strong> → the Client Secret
              </li>
            </ul>
            <p>
              The app exchanges these for a bearer token via OAuth2 client credentials
              (<code>POST /oauth/token</code>) and caches it until just before expiry.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '4. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the <strong>Connections</strong> page create a <strong>sailpoint-tenant</strong>{' '}
              connection and attach the credential. Use <strong>Test</strong> to verify the token
              exchange and ISC access.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Transform <strong>names</strong> and <strong>types</strong> are immutable in
              ISC, so the app matches transforms by name and protects built-in (internal) transforms
              — a same-name transform with a different type is never silently replaced.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
