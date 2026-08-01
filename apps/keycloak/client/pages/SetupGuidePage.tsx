import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Clients']

/**
 * Step-by-step connection guide for Keycloak, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Admin service account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Keycloak, create (or reuse) a confidential client to act as the admin service account. On
              that client enable <strong>Service accounts roles</strong>, then under{' '}
              <strong>Service account roles</strong> assign the realm-management role{' '}
              <code>manage-clients</code> (plus <code>view-realm</code>) for the realm you want to manage. Copy
              the client&apos;s <strong>Client ID</strong> and its <strong>Client secret</strong>. This app
              manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Alternatively you can use an admin username + password (the built-in <code>admin-cli</code>{' '}
              password grant). Store either the client-id or the admin username in the credential, and the
              secret/password alongside it on the <strong>Connections</strong> page.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection pointing at your Keycloak server base URL and
              attach the admin credential (client-id + secret). Set the <strong>Managed realm</strong> in the
              app&apos;s settings if it is not <code>master</code>. Use <strong>Test</strong> to verify: the app
              obtains an admin token (<code>POST /realms/&#123;realm&#125;/protocol/openid-connect/token</code>)
              and reads the realm (<code>GET /admin/realms/&#123;realm&#125;</code>). Saving the connection also
              registers the Keycloak realm as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Keycloak <strong>Clients</strong>{' '}
              configuration type, author your clients (client ID, name, protocol, enabled, public/confidential,
              standard flow, redirect URIs), and deploy through the pipeline. Deploy upserts by client ID; drift
              detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
