const { createClient } = require('redis');
const { Redis: UpstashRedis } = require('@upstash/redis');

// HACK: in-memory fallback when Redis is unavailable
const store = {};
const expiresAt = {};
let useMemory = false;
let connectionAttempted = false;

let client;
let upstashClient;

function isUpstashClientInstance(redisClient) {
  return Boolean(upstashClient) && redisClient === upstashClient;
}

function getUpstashConfig() {
  const restUrl =
    process.env.UPSTASH_REDIS_REST_URL ||
    (typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.startsWith('https://')
      ? process.env.REDIS_URL
      : '');
  const restToken =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.REDIS_TOKEN ||
    process.env.UPSTASH_TOKEN ||
    '';

  if (!restUrl || !restToken) {
    return null;
  }

  return {
    url: restUrl,
    token: restToken,
  };
}

function getRedisUrl() {
  return process.env.REDIS_URL;
}

function getUpstashClient() {
  if (upstashClient) {
    return upstashClient;
  }

  const config = getUpstashConfig();
  if (!config) {
    return null;
  }

  upstashClient = new UpstashRedis(config);
  return upstashClient;
}

function getClient() {
  if (client) {
    return client;
  }

  client = createClient({
    url: getRedisUrl(),
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: false,
    },
  });
  client.on('error', () => {
    useMemory = true;
  });

  return client;
}

async function ensureRedisConnected() {
  if (useMemory) {
    return null;
  }

  const upstash = getUpstashClient();
  if (upstash) {
    return upstash;
  }

  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    useMemory = true;
    console.warn('Redis URL missing - using in-memory store');
    return null;
  }

  if (connectionAttempted) {
    return useMemory ? null : getClient();
  }

  connectionAttempted = true;

  try {
    const redisClient = getClient();
    await redisClient.connect();
    return redisClient;
  } catch {
    useMemory = true;
    console.warn('Redis unavailable - using in-memory store');
    return null;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function purgeIfExpired(key) {
  const expiry = expiresAt[key];
  if (expiry && expiry <= nowSeconds()) {
    delete store[key];
    delete expiresAt[key];
  }
}

async function getRaw(key) {
  if (useMemory) {
    purgeIfExpired(key);
    return store[key] ?? null;
  }

  const redisClient = await ensureRedisConnected();
  if (!redisClient) {
    purgeIfExpired(key);
    return store[key] ?? null;
  }

  if (isUpstashClientInstance(redisClient)) {
    const value = await redisClient.get(key);
    if (value == null) {
      return null;
    }

    if (typeof value === 'string') {
      return value;
    }

    return JSON.stringify(value);
  }

  return redisClient.get(key);
}

async function setRaw(key, value, options) {
  if (useMemory) {
    store[key] = value;

    if (options && Number.isInteger(options.EX)) {
      expiresAt[key] = nowSeconds() + options.EX;
    } else {
      delete expiresAt[key];
    }

    return 'OK';
  }

  const redisClient = await ensureRedisConnected();
  if (!redisClient) {
    store[key] = value;

    if (options && Number.isInteger(options.EX)) {
      expiresAt[key] = nowSeconds() + options.EX;
    } else {
      delete expiresAt[key];
    }

    return 'OK';
  }

  if (isUpstashClientInstance(redisClient)) {
    if (options && Number.isInteger(options.EX)) {
      await redisClient.set(key, value, { ex: options.EX });
      return 'OK';
    }

    await redisClient.set(key, value);
    return 'OK';
  }

  return redisClient.set(key, value, options);
}

async function keysRaw(pattern) {
  if (useMemory) {
    const prefix = pattern.replace('*', '');
    return Object.keys(store).filter((key) => {
      purgeIfExpired(key);
      return key.startsWith(prefix) && store[key] != null;
    });
  }

  const redisClient = await ensureRedisConnected();
  if (!redisClient) {
    const prefix = pattern.replace('*', '');
    return Object.keys(store).filter((key) => {
      purgeIfExpired(key);
      return key.startsWith(prefix) && store[key] != null;
    });
  }

  if (isUpstashClientInstance(redisClient)) {
    return redisClient.keys(pattern);
  }

  return redisClient.keys(pattern);
}

async function mGetRaw(keys) {
  if (useMemory) {
    return keys.map((key) => {
      purgeIfExpired(key);
      return store[key] ?? null;
    });
  }

  const redisClient = await ensureRedisConnected();
  if (!redisClient) {
    return keys.map((key) => {
      purgeIfExpired(key);
      return store[key] ?? null;
    });
  }

  if (isUpstashClientInstance(redisClient)) {
    const values = await redisClient.mget(...keys);
    return values.map((value) => {
      if (value == null) {
        return null;
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  return redisClient.mGet(keys);
}

async function saveConnection(id, data) {
  await setRaw(`connection:${id}`, JSON.stringify(data));
}

async function getConnection(id) {
  const raw = await getRaw(`connection:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function getAllConnections() {
  const keys = await keysRaw('connection:*');

  if (keys.length === 0) {
    return [];
  }

  const values = await mGetRaw(keys);
  return values.filter(Boolean).map((value) => JSON.parse(value));
}

async function saveQueryContext(sessionId, context) {
  const key = `query-context:${sessionId}`;

  await setRaw(key, JSON.stringify(context), {
    EX: 60 * 30,
  });
}

async function getQueryContext(sessionId) {
  const raw = await getRaw(`query-context:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveUserProfile(sessionId, profile) {
  const key = `profile:${sessionId}`;
  await setRaw(key, JSON.stringify(profile));
}

async function getUserProfile(sessionId) {
  const raw = await getRaw(`profile:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

module.exports = {
  ensureRedisConnected,
  saveConnection,
  getConnection,
  getAllConnections,
  saveQueryContext,
  getQueryContext,
  saveUserProfile,
  getUserProfile,
};
