import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Applications']

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
              Open the <strong>Configuration Canvas</strong>, pick the authentik <strong>Applications</strong>{' '}
              configuration type, author your applications (name, slug, an optional bound provider pk,
              policy engine mode, UI group and display metadata), and deploy through the pipeline.
              Applications are upserted by slug; drift detection and rollback are handled per type.
            </p>
            <p>
              A bound <strong>Provider</strong> (OAuth2/OIDC, SAML, proxy, LDAP, …) must already exist in
              authentik — reference it by its numeric pk. Managing Providers as code is planned as a
              separate configuration type in a later release.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
