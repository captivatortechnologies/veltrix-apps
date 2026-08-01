import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'vectra-ai',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/vectra-ai/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/vectra-ai/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/vectra-ai/connections', label: 'Connections', icon: 'link' },
  ],
}
