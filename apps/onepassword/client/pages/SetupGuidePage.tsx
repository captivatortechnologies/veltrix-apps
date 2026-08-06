import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Users', 'Groups']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'bridge',
      label: '1. Deploy the SCIM Bridge',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              This app manages 1Password through the <strong>1Password SCIM Bridge</strong> - a small,
              self-hosted service that 1Password's supported identity providers (Google Workspace,
              JumpCloud, Microsoft Entra ID, Okta, OneLogin, Rippling) use to provision users and manage
              Groups. Deploy one from{' '}
              <a href="https://github.com/1Password/scim-examples" target="_blank" rel="noreferrer">
                1Password/scim-examples
              </a>{' '}
              (Docker, Kubernetes, or a cloud container platform) if you don't already have one running for
              your identity provider.
            </p>
            <p>
              During setup you'll be given a <strong>bearer token</strong> (the <code>scimsession</code>{' '}
              credential) - this is the same token your identity provider uses, and what this app
              authenticates with too.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'store',
      label: '2. Store the token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the bridge's bearer token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> - the bridge's bearer token
              </li>
            </ul>
            <p>
              No username is needed. The app sends it as <code>Authorization: Bearer &lt;token&gt;</code>{' '}
              on every request - the same header used by <code>curl</code> against the bridge's own{' '}
              <code>/health</code> endpoint.
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
              Register an <strong>onepassword-scim-bridge</strong> component whose hostname is the SCIM
              Bridge's own base URL (e.g. <code>https://scim.example.com</code> - no trailing slash, no{' '}
              <code>/scim/v2</code> path), and attach the credential.
            </p>
            <p>
              Manages: {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the pipeline.
              Note: this app never manages Vaults or the items inside them (1Password's Connect API has no
              config-as-code surface for either), Service Accounts (no REST API exists), or a hard delete
              of a User/Group (not documented by the bridge - see README Coverage).
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
