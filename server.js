require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { fetchConnections } = require('./apify');
const {
  scoreConnections,
  suggestActions,
  updateUserProfile,
  filterByProfile,
} = require('./agent');
const {
  ensureRedisConnected,
  saveConnection,
  getAllConnections,
  saveQueryContext,
  getQueryContext,
  getUserProfile,
} = require('./redis');

const app = express();
const port = Number(process.env.PORT || 3001);
const SCORE_CANDIDATE_LIMIT = 120;
const ACTIONS_OPENAI_LIMIT = 3;
const SCORE_TIMEOUT_MS = 10000;

app.use(
  cors({
    origin: ['http://localhost:3000'],
  })
);
app.use(express.json());

async function seedConnectionsIfEmpty() {
  const existingConnections = await getAllConnections();

  if (existingConnections.length > 0) {
    return;
  }

  const seededConnections = await fetchConnections();
  await Promise.all(
    seededConnections.map((connection) => saveConnection(connection.id, connection))
  );

  console.log(`Seeded ${seededConnections.length} connections into Redis.`);
}

function keywordScore(connection, terms) {
  const haystack = [
    connection.name,
    connection.role,
    connection.company,
    connection.location,
    ...(Array.isArray(connection.tags) ? connection.tags : []),
    connection.notes,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return terms.reduce((score, term) => (haystack.includes(term) ? score + 1 : score), 0);
}

function prefilterConnectionsByQuery(connections, query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  if (terms.length === 0 || connections.length <= SCORE_CANDIDATE_LIMIT) {
    return connections;
  }

  return [...connections]
    .map((connection) => ({
      connection,
      score: keywordScore(connection, terms),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SCORE_CANDIDATE_LIMIT)
    .map((item) => item.connection);
}

function heuristicRank(query, connections, limit) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  return [...connections]
    .map((connection) => {
      const score = terms.length > 0 ? keywordScore(connection, terms) * 20 : 0;
      return {
        ...connection,
        relevanceScore: Math.max(0, Math.min(100, score)),
        reason: 'Matched by keyword fallback ranking.',
      };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function toIsoDay(dateString) {
  if (!dateString || typeof dateString !== 'string') {
    return null;
  }
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function buildStats(connections) {
  const total = connections.length;
  const linkedin = connections.filter((c) => (c.platforms || []).includes('LinkedIn')).length;
  const instagram = connections.filter((c) => (c.platforms || []).includes('Instagram')).length;
  const overlap = connections.filter(
    (c) => (c.platforms || []).includes('LinkedIn') && (c.platforms || []).includes('Instagram')
  ).length;

  const last7 = new Date();
  last7.setDate(last7.getDate() - 7);
  const newThisWeek = connections.filter((c) => {
    const d = toIsoDay(c.lastInteraction);
    if (!d) return false;
    return new Date(d) >= last7;
  }).length;

  return {
    totalConnections: total,
    linkedinCount: linkedin,
    instagramCount: instagram,
    overlapCount: overlap,
    newThisWeek,
  };
}

function toConnectionCard(connection) {
  const fullName = connection.name || 'Unknown';
  const initials = fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');

  const roleCompany = [connection.role, connection.company].filter(Boolean).join(' · ');
  const platforms = (connection.platforms || []).map((platform) =>
    platform === 'LinkedIn' ? 'LI' : platform === 'Instagram' ? 'IG' : platform
  );

  return {
    id: connection.id,
    initials: initials || 'NA',
    name: fullName,
    roleCompany: roleCompany || 'Network connection',
    location: connection.location || '',
    platforms,
  };
}

function buildSuggestedActions(connections, stats) {
  const newest = [...connections]
    .filter((c) => c.lastInteraction)
    .sort((a, b) => new Date(b.lastInteraction) - new Date(a.lastInteraction))
    .slice(0, 2);

  const newestNames = newest.map((c) => c.name).filter(Boolean);
  const newestText = newestNames.length ? newestNames.join(' and ') : 'new contacts';

  return [
    {
      id: 'live-a1',
      title: 'Follow up with newest connections',
      description: `Send a short message to ${newestText}.`,
      buttonLabel: 'Review',
    },
    {
      id: 'live-a2',
      title: `${stats.overlapCount} contacts on both platforms`,
      description: 'Merge profiles to unlock better ranking quality.',
      buttonLabel: 'Merge',
    },
    {
      id: 'live-a3',
      title: `${stats.newThisWeek} new connections this week`,
      description: 'Prioritize warm intros before they cool down.',
      buttonLabel: 'Draft intro',
    },
  ];
}

async function hydrateResultsFromConnections(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const needsHydration = results.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      (!item.profileImageUrl || !item.username || !item.id)
  );

  if (!needsHydration) {
    return results;
  }

  const connections = await getAllConnections();
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const byName = new Map(
    connections
      .filter((connection) => typeof connection.name === 'string' && connection.name.trim().length > 0)
      .map((connection) => [connection.name.trim().toLowerCase(), connection])
  );

  return results.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const connection =
      (item.id ? byId.get(item.id) : null) ||
      (typeof item.name === 'string' ? byName.get(item.name.trim().toLowerCase()) : null);

    if (!connection) {
      return item;
    }

    return {
      ...item,
      id: item.id || connection.id,
      username: item.username || connection.username || null,
      platforms:
        Array.isArray(item.platforms) && item.platforms.length > 0
          ? item.platforms
          : connection.platforms || [],
      profileImageUrl: item.profileImageUrl || connection.profileImageUrl || null,
    };
  });
}

app.post('/api/query', async (req, res) => {
  try {
    const { query, sessionId } = req.body || {};

    if (!query || typeof query !== 'string' || !sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({
        error: 'Both query and sessionId are required strings.',
      });
    }

    const cachedContext = await getQueryContext(sessionId);
    if (cachedContext && cachedContext.query === query) {
      const hydratedResults = await hydrateResultsFromConnections(cachedContext.results || []);
      return res.json({
        results: hydratedResults,
      });
    }

    const connections = await getAllConnections();
    const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
    const connectionByName = new Map(
      connections
        .filter((connection) => typeof connection.name === 'string' && connection.name.trim().length > 0)
        .map((connection) => [connection.name.trim().toLowerCase(), connection])
    );
    const candidates = prefilterConnectionsByQuery(connections, query);
    let scoredConnections = [];
    try {
      scoredConnections = await withTimeout(scoreConnections(query, candidates), SCORE_TIMEOUT_MS);
    } catch {
      scoredConnections = heuristicRank(query, candidates, 50);
    }
    const rawTopResults = scoredConnections.slice(0, 15);
    const profile = await getUserProfile(sessionId);
    const profileFiltered = await filterByProfile(rawTopResults, profile);
    const topCandidates = (profileFiltered || rawTopResults).slice(0, 5);

    const topResults = await Promise.all(
      topCandidates.map(async (connection, index) => {
        const sourceConnection =
          (connection && connection.id ? connectionById.get(connection.id) : null) ||
          (typeof connection?.name === 'string'
            ? connectionByName.get(connection.name.trim().toLowerCase())
            : null);

        let actions = [];

        try {
          if (index < ACTIONS_OPENAI_LIMIT) {
            actions = await suggestActions(connection);
          } else {
            actions = ['Draft intro email', 'Send quick follow-up'];
          }
        } catch {
          actions = ['Draft intro email', 'Send quick follow-up'];
        }

        return {
          id: connection.id || sourceConnection?.id || null,
          username: connection.username || sourceConnection?.username || null,
          name: connection.name || sourceConnection?.name || 'Unknown',
          role: connection.role || sourceConnection?.role || 'Unknown',
          company: connection.company || sourceConnection?.company || 'Unknown',
          platforms: connection.platforms || sourceConnection?.platforms || [],
          profileImageUrl: connection.profileImageUrl || sourceConnection?.profileImageUrl || null,
          relevanceScore: connection.relevanceScore,
          reason: connection.reason,
          suggestedActions: actions,
          profileMatchReason:
            typeof connection.profileMatchReason === 'string'
              ? connection.profileMatchReason
              : null,
        };
      })
    );

    await saveQueryContext(sessionId, {
      query,
      results: topResults,
      createdAt: new Date().toISOString(),
    });

    res.json({ results: topResults });

    setImmediate(() => {
      updateUserProfile(sessionId, query, topCandidates).catch(() => {
        // Ignore profile update failures: request is already fulfilled.
      });
    });

    return;
  } catch (error) {
    console.error('Query handling failed:', error);
    return res.status(500).json({
      error: 'Unable to process query right now. Please try again.',
    });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const connections = await getAllConnections();
    return res.json({ stats: buildStats(connections) });
  } catch (error) {
    console.error('Stats fetch failed:', error);
    return res.status(500).json({ error: 'Unable to load stats right now.' });
  }
});

app.get('/api/connections', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 8), 50));
    const connections = await getAllConnections();

    const latest = [...connections]
      .sort((a, b) => {
        const dA = new Date(a.lastInteraction || 0).getTime();
        const dB = new Date(b.lastInteraction || 0).getTime();
        return dB - dA;
      })
      .slice(0, limit)
      .map(toConnectionCard);

    return res.json({ connections: latest });
  } catch (error) {
    console.error('Connections fetch failed:', error);
    return res.status(500).json({ error: 'Unable to load connections right now.' });
  }
});

app.get('/api/actions', async (_req, res) => {
  try {
    const connections = await getAllConnections();
    const stats = buildStats(connections);
    return res.json({ actions: buildSuggestedActions(connections, stats) });
  } catch (error) {
    console.error('Actions fetch failed:', error);
    return res.status(500).json({ error: 'Unable to load actions right now.' });
  }
});

app.get('/api/profile/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const profile = await getUserProfile(sessionId);
    return res.json({ profile });
  } catch (error) {
    console.error('Profile fetch failed:', error);
    return res.status(500).json({
      error: 'Unable to load profile right now.',
    });
  }
});

// Serve the built frontend for single-service deployment (e.g., Render).
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

async function start() {
  try {
    await ensureRedisConnected();
    await seedConnectionsIfEmpty();

    app.listen(port, () => {
      console.log(`Connectify backend listening on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
