const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

const copy = value => value == null ? null : structuredClone(value);
const unavailable = () => Object.assign(new Error('Shared storage is unavailable. Try again shortly.'), { status: 503 });

// Identical interface in development and Redis. Mutators must be synchronous,
// side-effect-free functions: Redis may retry them after a concurrent write.
class MemoryStore {
  constructor() { this.entries = new Map(); this.ready = true; }
  read(key) {
    const entry = this.entries.get(key);
    if (entry?.expires && entry.expires <= Date.now()) { this.entries.delete(key); return null; }
    return entry || null;
  }
  async get(key) { return copy(this.read(key)?.value); }
  async set(key, value, ttl = 86400) {
    if (this.entries.size > 50000) {
      for (const name of this.entries.keys()) this.read(name);
      if (this.entries.size > 50000 && !this.entries.has(key)) throw unavailable();
    }
    if (value == null) this.entries.delete(key);
    else this.entries.set(key, { value: copy(value), expires: ttl ? Date.now() + ttl * 1000 : 0 });
    return value;
  }
  async update(key, mutate, ttl = 86400) {
    const value = mutate(copy(this.read(key)?.value));
    await this.set(key, value, ttl);
    return copy(value);
  }
  async guardedSet(guardKey, expected, key, value, ttl = 86400) {
    if (JSON.stringify(this.read(guardKey)?.value) !== JSON.stringify(expected)) return false;
    await this.set(key, value, ttl); return true;
  }
  async guardedUpdate(guardKey, expected, key, mutate, ttl = 86400) {
    if (JSON.stringify(this.read(guardKey)?.value) !== JSON.stringify(expected)) return null;
    const value = mutate(copy(this.read(key)?.value));
    await this.set(key, value, ttl); return value;
  }
  async touch(key, ttl = 86400) {
    const entry = this.read(key); if (entry) entry.expires = Date.now() + ttl * 1000;
  }
  async limit(key, maximum, seconds) {
    const name = `limit:${key}`;
    const entry = this.read(name);
    const count = (entry?.value || 0) + 1;
    this.entries.set(name, { value: count, expires: entry?.expires || Date.now() + seconds * 1000 });
    return count <= maximum;
  }
  async ping() { return this.ready; }
  async close() { this.ready = false; }
}

class RedisStore {
  constructor(client, { encryptionKey, prefix = 'samerow:v1' }) {
    this.client = client; this.prefix = prefix;
    this.secret = Buffer.from(encryptionKey || '', 'hex');
    if (this.secret.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  }
  get ready() { return this.client.isReady; }
  key(key) { return `${this.prefix}:${createHash('sha256').update(key).digest('hex')}`; }
  encode(value, key) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    cipher.setAAD(Buffer.from(key));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  decode(raw, key) {
    if (!raw) return null;
    const data = Buffer.from(raw, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.secret, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(key)); decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
  }
  check() { if (!this.ready) throw unavailable(); }
  async get(key) { this.check(); return this.decode(await this.client.get(this.key(key)), key); }
  async set(key, value, ttl = 86400) {
    this.check();
    if (value == null) await this.client.del(this.key(key));
    else await this.client.set(this.key(key), this.encode(value, key), ttl ? { EX: ttl } : {});
    return value;
  }
  async update(key, mutate, ttl = 86400) {
    this.check();
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = await this.client.get(this.key(key));
      const value = mutate(this.decode(raw, key));
      const encoded = value == null ? '' : this.encode(value, key);
      const result = await this.client.eval(`
        local old = redis.call('GET', KEYS[1])
        if (old or '') ~= ARGV[1] then return 0 end
        if ARGV[2] == '' then redis.call('DEL', KEYS[1])
        elseif tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
        else redis.call('SET', KEYS[1], ARGV[2]) end
        return 1`, { keys: [this.key(key)], arguments: [raw || '', encoded, String(ttl || 0)] });
      if (result === 1) return value;
    }
    throw unavailable();
  }
  async guardedSet(guardKey, expected, key, value, ttl = 86400) {
    this.check();
    const raw = await this.client.get(this.key(guardKey));
    if (JSON.stringify(this.decode(raw, guardKey)) !== JSON.stringify(expected)) return false;
    return await this.client.eval(`if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end; redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); return 1`,
      { keys: [this.key(guardKey), this.key(key)], arguments: [raw || '', this.encode(value, key), String(ttl)] }) === 1;
  }
  async guardedUpdate(guardKey, expected, key, mutate, ttl = 86400) {
    this.check();
    for (let attempt = 0; attempt < 50; attempt++) {
      const [guardRaw, raw] = await this.client.mGet([this.key(guardKey), this.key(key)]);
      if (JSON.stringify(this.decode(guardRaw, guardKey)) !== JSON.stringify(expected)) return null;
      const value = mutate(this.decode(raw, key));
      const changed = await this.client.eval(`if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] or (redis.call('GET', KEYS[2]) or '') ~= ARGV[2] then return 0 end; redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4]); return 1`,
        { keys: [this.key(guardKey), this.key(key)], arguments: [guardRaw || '', raw || '', this.encode(value, key), String(ttl)] });
      if (changed === 1) return value;
    }
    throw unavailable();
  }
  async touch(key, ttl = 86400) { this.check(); await this.client.expire(this.key(key), ttl); }
  async limit(key, maximum, seconds) {
    this.check();
    const count = await this.client.eval(`local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n`,
      { keys: [this.key(`limit:${key}`)], arguments: [String(seconds)] });
    return count <= maximum;
  }
  async ping() {
    this.check();
    if (await this.client.ping() !== 'PONG') return false;
    // A full noeviction store can answer PING while rejecting every room write.
    await this.client.set(`${this.prefix}:readiness`, '1', { EX: 30 });
    return true;
  }
  async close() { if (this.client.isOpen) await this.client.quit(); }
}

async function createStore(config) {
  if (!config.redisUrl) return new MemoryStore();
  const { createClient } = require('redis');
  const client = createClient({ url: config.redisUrl, disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(100 + retries * 200, 3000) } });
  client.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'redis_unavailable' })));
  await client.connect();
  return new RedisStore(client, config);
}

module.exports = { MemoryStore, RedisStore, createStore };
