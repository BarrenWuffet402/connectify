const { createHash, randomUUID } = require('node:crypto');
const { ApifyClient } = require('apify-client');

const INSTAGRAM_ACTOR_ID = 'jWD4G57HhqYY0mFhd';
const INSTAGRAM_ACCOUNT = ['deon_tech'];
const INSTAGRAM_RESULTS_LIMIT = 2000;

const SAMPLE_LINKEDIN_CONNECTIONS = [
  {
    id: randomUUID(),
    name: 'Leila Park',
    role: 'ML Engineer',
    company: 'OpenAI',
    location: 'San Francisco, CA',
    platforms: ['LinkedIn'],
    tags: ['AI', 'Engineering'],
    lastInteraction: '2026-03-18',
    notes: 'Sample LinkedIn profile. Works on AI developer tooling.',
  },
  {
    id: randomUUID(),
    name: 'James Tao',
    role: 'Research Scientist',
    company: 'Anthropic',
    location: 'San Francisco, CA',
    platforms: ['LinkedIn'],
    tags: ['AI', 'Research'],
    lastInteraction: '2026-03-14',
    notes: 'Sample LinkedIn profile. Interested in research collaboration.',
  },
  {
    id: randomUUID(),
    name: 'Nina Solis',
    role: 'Product Lead',
    company: 'Cohere',
    location: 'San Francisco, CA',
    platforms: ['LinkedIn'],
    tags: ['AI', 'Product'],
    lastInteraction: '2026-03-12',
    notes: 'Sample LinkedIn profile. Strong GTM and product strategy background.',
  },
  {
    id: randomUUID(),
    name: 'Dan Walsh',
    role: 'Investor',
    company: 'Andreessen Horowitz',
    location: 'Menlo Park, CA',
    platforms: ['LinkedIn'],
    tags: ['Investor', 'AI'],
    lastInteraction: '2026-03-06',
    notes: 'Sample LinkedIn profile. Focused on applied AI startups.',
  },
];

function stableIdFromUsername(username) {
  return createHash('sha256').update(`instagram:${username}`).digest('hex').slice(0, 24);
}

function getString(value, fallback = '') {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function mapInstagramItemToConnection(item) {
  const username = getString(item.username || item.userName || item.handle, 'unknown');
  const fullName = getString(item.fullName || item.full_name || item.name, username);
  const biography = getString(item.biography || item.bio, 'Imported from Instagram followers.');

  const companyGuess =
    getString(item.businessCategoryName) ||
    getString(item.businessCategory) ||
    getString(item.category) ||
    'Instagram';

  const connection = {
    id: stableIdFromUsername(username),
    name: fullName,
    role: 'Creator',
    company: companyGuess,
    location: getString(item.locationName || item.location, 'Unknown'),
    platforms: ['Instagram'],
    tags: ['Instagram', 'Follower'],
    lastInteraction: new Date().toISOString().slice(0, 10),
    notes: biography,
  };

  return connection;
}

async function fetchInstagramFollowersFromApify() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN is missing.');
  }

  const client = new ApifyClient({ token });
  const runInput = {
    Account: INSTAGRAM_ACCOUNT,
    resultsLimit: INSTAGRAM_RESULTS_LIMIT,
    dataToScrape: 'Followers',
  };

  const run = await client.actor(INSTAGRAM_ACTOR_ID).call(runInput);
  const datasetId = run?.defaultDatasetId;

  if (!datasetId) {
    return [];
  }

  const { items } = await client.dataset(datasetId).listItems({ limit: INSTAGRAM_RESULTS_LIMIT });

  const mapped = (Array.isArray(items) ? items : [])
    .map(mapInstagramItemToConnection)
    .filter((connection) => connection.name && connection.id);

  const uniqueById = new Map(mapped.map((connection) => [connection.id, connection]));
  return [...uniqueById.values()];
}

async function fetchConnections() {
  // TODO: replace with real Apify actor call using APIFY_TOKEN
  try {
    const instagramConnections = await fetchInstagramFollowersFromApify();

    if (instagramConnections.length > 0) {
      return [...instagramConnections, ...SAMPLE_LINKEDIN_CONNECTIONS];
    }
  } catch (error) {
    console.warn('Instagram fetch failed, falling back to sample data:', error.message);
  }

  return [
    {
      id: randomUUID(),
      name: 'Marcus Kim',
      role: 'Founder',
      company: 'YC W24',
      location: 'New York, NY',
      platforms: ['Instagram'],
      tags: ['Founder', 'SaaS'],
      lastInteraction: '2026-03-09',
      notes: 'Fallback Instagram sample record.',
    },
    {
      id: randomUUID(),
      name: 'Sara Reyes',
      role: 'Product Manager',
      company: 'Stripe',
      location: 'San Francisco, CA',
      platforms: ['Instagram'],
      tags: ['Fintech', 'Hiring'],
      lastInteraction: '2026-03-10',
      notes: 'Fallback Instagram sample record.',
    },
    ...SAMPLE_LINKEDIN_CONNECTIONS,
  ];
}

module.exports = {
  fetchConnections,
};
