const OpenAI = require('openai');
const { getUserProfile, saveUserProfile } = require('./redis');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const SCORE_SYSTEM_PROMPT = [
  'You are a network relevance scoring assistant.',
  'Given a user query and connection data, return ONLY JSON.',
  'Output schema:',
  '{ "results": [{ "id": "string", "relevanceScore": 0, "reason": "string" }] }',
  'Rules:',
  '- relevanceScore must be an integer 0 to 100.',
  '- reason must be one short sentence.',
  '- Include every connection id exactly once.',
].join('\n');

const ACTION_SYSTEM_PROMPT = [
  'You generate two concise relationship-building actions for one professional contact.',
  'Return ONLY JSON with schema:',
  '{ "actions": ["action one", "action two"] }',
  'Actions should be short, practical, and specific to the person role/tags.',
].join('\n');

const PROFILE_UPDATE_SYSTEM_PROMPT = [
  'You are a user intent analyzer. Based on the user\'s search history and latest query, update their profile.',
  'Return ONLY valid JSON, no markdown, no explanation.',
].join('\n');

const PROFILE_FILTER_SYSTEM_PROMPT = [
  'You are a relevance filter. Re-rank connections for a founder based on their profile.',
  'Return ONLY a valid JSON array, no markdown, no explanation.',
].join('\n');

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required in environment variables.');
  }

  return new OpenAI({ apiKey });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildDefaultProfile() {
  return {
    inferredIndustry: '',
    inferredStage: '',
    inferredGoals: [],
    avoidPatterns: [],
    searchHistory: [],
    queryCount: 0,
  };
}

function normalizeProfile(profile, fallbackQuery) {
  const base = buildDefaultProfile();
  const incoming = profile && typeof profile === 'object' ? profile : {};

  const searchHistory = Array.isArray(incoming.searchHistory)
    ? incoming.searchHistory.filter(
        (item) => item && typeof item.query === 'string' && typeof item.timestamp === 'string'
      )
    : [];

  const queryCount = Number.isFinite(incoming.queryCount)
    ? Math.max(0, Math.floor(incoming.queryCount))
    : searchHistory.length;

  const normalized = {
    inferredIndustry:
      typeof incoming.inferredIndustry === 'string' ? incoming.inferredIndustry : base.inferredIndustry,
    inferredStage: typeof incoming.inferredStage === 'string' ? incoming.inferredStage : base.inferredStage,
    inferredGoals: Array.isArray(incoming.inferredGoals)
      ? incoming.inferredGoals.filter((goal) => typeof goal === 'string')
      : base.inferredGoals,
    avoidPatterns: Array.isArray(incoming.avoidPatterns)
      ? incoming.avoidPatterns.filter((pattern) => typeof pattern === 'string')
      : base.avoidPatterns,
    searchHistory,
    queryCount,
  };

  if (fallbackQuery) {
    normalized.searchHistory = [
      ...normalized.searchHistory,
      { query: fallbackQuery, timestamp: new Date().toISOString() },
    ];
    normalized.queryCount = Math.max(normalized.queryCount + 1, normalized.searchHistory.length);
  }

  return normalized;
}

function summarizeResultsForProfile(results) {
  return (results || []).slice(0, 5).map((item) => ({
    name: item.name,
    role: item.role,
    company: item.company,
    tags: Array.isArray(item.tags) ? item.tags : [],
  }));
}

function resultKey(item) {
  return [item.id || '', item.name || '', item.role || '', item.company || ''].join('|');
}

async function scoreConnections(query, connections) {
  if (!Array.isArray(connections) || connections.length === 0) {
    return [];
  }

  try {
    const client = getOpenAIClient();

    const userPrompt = JSON.stringify(
      {
        query,
        connections: connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          role: connection.role,
          company: connection.company,
          location: connection.location,
          platforms: connection.platforms,
          tags: connection.tags,
          notes: connection.notes,
          lastInteraction: connection.lastInteraction,
        })),
      },
      null,
      2
    );

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SCORE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const text = completion.choices?.[0]?.message?.content || '{}';
    const parsed = safeJsonParse(text);
    const scored = Array.isArray(parsed?.results) ? parsed.results : [];

    const byId = new Map(connections.map((connection) => [connection.id, connection]));

    const merged = scored
      .map((item) => {
        const original = byId.get(item.id);
        if (!original) {
          return null;
        }

        const score = Number.isFinite(item.relevanceScore)
          ? Math.max(0, Math.min(100, Math.round(item.relevanceScore)))
          : 0;

        return {
          ...original,
          relevanceScore: score,
          reason:
            typeof item.reason === 'string' && item.reason.trim().length > 0
              ? item.reason
              : 'Potentially relevant connection.',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    if (merged.length > 0) {
      return merged;
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return connections.map((connection) => ({
    ...connection,
    relevanceScore: 0,
    reason: 'Scoring temporarily unavailable.',
  }));
}

async function suggestActions(connection) {
  try {
    const client = getOpenAIClient();

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: 'system', content: ACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify(
            {
              name: connection.name,
              role: connection.role,
              company: connection.company,
              tags: connection.tags,
              notes: connection.notes,
            },
            null,
            2
          ),
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = completion.choices?.[0]?.message?.content || '{}';
    const parsed = safeJsonParse(text);
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];

    return actions
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 2);
  } catch {
    return [];
  }
}

async function updateUserProfile(sessionId, query, results) {
  try {
    const existingProfile = (await getUserProfile(sessionId)) || buildDefaultProfile();
    const topResultSummary = summarizeResultsForProfile(results);

    const prompt = [
      `Current profile: ${JSON.stringify(existingProfile, null, 2)}`,
      `Latest query: ${query}`,
      `Top results seen: ${JSON.stringify(topResultSummary, null, 2)}`,
      '',
      'Return updated profile JSON:',
      '{',
      '  "inferredIndustry": "string",',
      '  "inferredStage": "string",',
      '  "inferredGoals": ["string"],',
      '  "avoidPatterns": ["string"],',
      '  "searchHistory": [{ "query": "string", "timestamp": "ISO date" }],',
      '  "queryCount": 0',
      '}',
    ].join('\n');

    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PROFILE_UPDATE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    const text = completion.choices?.[0]?.message?.content || '{}';
    const parsed = safeJsonParse(text);

    const updated = normalizeProfile(parsed, null);
    updated.searchHistory = [
      ...updated.searchHistory,
      { query, timestamp: new Date().toISOString() },
    ];
    updated.queryCount = Math.max(updated.queryCount + 1, updated.searchHistory.length);

    await saveUserProfile(sessionId, updated);
  } catch {
    // Swallow errors: profile updates must never block request lifecycle.
  }
}

async function filterByProfile(results, profile) {
  if (!profile || !Number.isFinite(profile.queryCount) || profile.queryCount < 2) {
    return results;
  }

  try {
    const rawConnections = (results || []).slice(0, 15);
    const prompt = [
      `User profile: ${JSON.stringify(profile, null, 2)}`,
      '',
      `Raw connections (top 15): ${JSON.stringify(rawConnections, null, 2)}`,
      '',
      'Re-rank and return the top 5 that best match:',
      `- inferredIndustry: ${profile.inferredIndustry || ''}`,
      `- inferredGoals: ${JSON.stringify(profile.inferredGoals || [])}`,
      `Penalize connections matching: ${JSON.stringify(profile.avoidPatterns || [])}`,
      '',
      'Return JSON array, same shape as input, add field:',
      'profileMatchReason: one sentence why this person is relevant',
    ].join('\n');

    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PROFILE_FILTER_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });

    const text = completion.choices?.[0]?.message?.content || '[]';
    const parsed = safeJsonParse(text);

    let ranked = [];
    if (Array.isArray(parsed)) {
      ranked = parsed;
    } else if (Array.isArray(parsed?.results)) {
      ranked = parsed.results;
    }

    if (!Array.isArray(ranked) || ranked.length === 0) {
      return results;
    }

    const byKey = new Map(results.map((item) => [resultKey(item), item]));

    const merged = ranked
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const original = byKey.get(resultKey(item));
        if (!original) {
          return null;
        }

        return {
          ...original,
          ...item,
          profileMatchReason:
            typeof item.profileMatchReason === 'string' && item.profileMatchReason.trim().length > 0
              ? item.profileMatchReason
              : null,
        };
      })
      .filter(Boolean);

    return merged.length > 0 ? merged.slice(0, 5) : results;
  } catch {
    return results;
  }
}

module.exports = {
  scoreConnections,
  suggestActions,
  updateUserProfile,
  filterByProfile,
};
