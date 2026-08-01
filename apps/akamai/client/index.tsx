import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'akamai',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/akamai/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/akamai/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/akamai/connections', label: 'Connections', icon: 'link' },
  ],
}
