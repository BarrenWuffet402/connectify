import React, { useEffect, useState } from 'react';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import StatsBar from './components/StatsBar';
import ConnectionList from './components/ConnectionList';
import AIChatPanel from './components/AIChatPanel';
import NetworkMapPreview from './components/NetworkMapPreview';
import SuggestedActions from './components/SuggestedActions';

function createSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `session-${Date.now()}`;
}

// Master page layout: navbar, fixed sidebar, and 3-row dashboard content.
export default function App() {
  const [sessionId] = useState(createSessionId);
  const [stats, setStats] = useState(null);
  const [connections, setConnections] = useState([]);
  const [actions, setActions] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboardData() {
      try {
        const [statsRes, connectionsRes, actionsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/connections?limit=8'),
          fetch('/api/actions'),
        ]);

        if (!cancelled && statsRes.ok) {
          const payload = await statsRes.json();
          setStats(payload.stats || null);
        }

        if (!cancelled && connectionsRes.ok) {
          const payload = await connectionsRes.json();
          setConnections(Array.isArray(payload.connections) ? payload.connections : []);
        }

        if (!cancelled && actionsRes.ok) {
          const payload = await actionsRes.json();
          setActions(Array.isArray(payload.actions) ? payload.actions : []);
        }
      } catch {
        // Keep placeholder UI if API fetch fails.
      }
    }

    loadDashboardData();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#f5f5f3] text-zinc-900">
      <Navbar />
      <Sidebar />

      <main className="px-4 pb-6 pt-[88px] md:ml-[230px] md:px-6 lg:px-8">
        <div className="mx-auto max-w-[1200px] space-y-6">
          <StatsBar stats={stats} />

          <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <ConnectionList connections={connections} />
            <AIChatPanel sessionId={sessionId} />
          </section>

          <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <NetworkMapPreview />
            <SuggestedActions actions={actions} />
          </section>
        </div>
      </main>
    </div>
  );
}
