import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Apps', 'Roles', 'User Mappings', 'App Rules', 'Privileges', 'Account Brands']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the OneLogin admin console, go to <strong>Developers &gt; API Credentials</strong>,
              click <strong>New Credential</strong>, and grant it the <strong>Manage All</strong> scope
              (or a narrower scope covering what this app manages):
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the credential's <strong>Client ID</strong> and <strong>Client Secret</strong> - the
              secret is shown once.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'store',
      label: '2. Store the credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the API credential as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the API credential's Client ID
              </li>
              <li>
                <strong>API token</strong> - the API credential's Client Secret
              </li>
            </ul>
            <p>
              The app exchanges these for a short-lived access token via the OAuth2{' '}
              <code>client_credentials</code> grant on every deploy.
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
              Register an <strong>onelogin-account</strong> component whose hostname is your OneLogin{' '}
              <strong>subdomain</strong> (e.g. <code>acme</code> or <code>acme.onelogin.com</code> - the
              same address you use to log in), attach the credential. OneLogin has no separate
              region/data-center API host to select - the subdomain alone identifies the account.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Note: OneLogin protects the account's <strong>master brand</strong> and does not
              expose Groups as a writable API (directory-synced or admin-console-managed only) - this
              app never touches either.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
