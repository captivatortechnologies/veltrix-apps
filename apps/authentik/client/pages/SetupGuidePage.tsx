import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Applications', 'OAuth2/OpenID Providers', 'Groups', 'Flows']

/**
 * Step-by-step connection guide for authentik, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In authentik, go to <strong>Directory → Tokens</strong> (or create a dedicated Service
              account and copy its auto-generated token) and create a token for a user with permission to
              manage:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the token value — authentik shows it once. It is a static, long-lived credential sent as{' '}
              <code>Authorization: Bearer &lt;token&gt;</code> on every API call (no OAuth exchange).
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
              On <strong>Connections</strong>, add a connection pointing at your authentik instance host
              (e.g. <code>authentik.example.com</code>) and paste the token into the{' '}
              <strong>API token</strong> field. Use <strong>Test</strong> to verify the token is accepted (
              <code>GET /api/v3/core/applications/?page_size=1</code>). Saving the connection also
              registers the instance as a deploy target.
            </p>
            <p>
              A fresh self-hosted authentik instance commonly runs behind a self-signed certificate — leave
              the app's <strong>Verify TLS certificate</strong> setting off until a trusted certificate is
              in place.
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
              Open the <strong>Configuration Canvas</strong> and pick one of authentik's four configuration
              types. Each is upserted by its own identity and gets drift detection + rollback:
            </p>
            <ul>
              <li>
                <strong>Applications</strong> (by slug) — name, slug, an optional bound Provider pk, policy
                engine mode, UI group and display metadata.
              </li>
              <li>
                <strong>OAuth2/OpenID Providers</strong> (by name) — client type/id, an authorization and
                invalidation flow (by Flow UUID), redirect URIs and scope mappings. Deploy one of these
                first, then paste its pk into an Application's <strong>Provider</strong> field to bind them.
              </li>
              <li>
                <strong>Groups</strong> (by name) — the superuser flag, an optional parent group and custom
                attributes. Group membership and RBAC roles are managed directly in authentik.
              </li>
              <li>
                <strong>Flows</strong> (by slug) — title, designation and the required authentication level.
                A deployed flow's UUID can be pasted into a Provider's Authorization/Invalidation Flow
                fields.
              </li>
            </ul>
            <p>
              Provider/flow references are authored as plain UUIDs (no live picker yet) — copy them from
              authentik's admin interface or from this app's own deploy artifacts.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
