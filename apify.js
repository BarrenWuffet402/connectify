const { createHash, randomUUID } = require('node:crypto');
const { ApifyClient } = require('apify-client');

const INSTAGRAM_ACTOR_ID = 'jWD4G57HhqYY0mFhd';
const INSTAGRAM_ACCOUNT = ['deon_tech'];
const INSTAGRAM_RESULTS_LIMIT = 2000;

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
  const profileImageUrl =
    getString(item.profilePicUrlHD) ||
    getString(item.profilePicUrl) ||
    getString(item.profile_pic_url_hd) ||
    getString(item.profile_pic_url) ||
    '';

  const companyGuess =
    getString(item.businessCategoryName) ||
    getString(item.businessCategory) ||
    getString(item.category) ||
    'Instagram';

  const connection = {
    id: stableIdFromUsername(username),
    username,
    name: fullName,
    role: 'Creator',
    company: companyGuess,
    location: getString(item.locationName || item.location, 'Unknown'),
    platforms: ['Instagram'],
    tags: ['Instagram', 'Follower'],
    lastInteraction: new Date().toISOString().slice(0, 10),
    notes: biography,
    profileImageUrl,
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
  // TODO: optionally merge with real LinkedIn source once available.
  try {
    const instagramConnections = await fetchInstagramFollowersFromApify();

    if (instagramConnections.length > 0) {
      return instagramConnections;
    }
  } catch (error) {
    console.warn('Instagram fetch failed, falling back to sample data:', error.message);
  }

  return [];
}

module.exports = {
  fetchConnections,
};
