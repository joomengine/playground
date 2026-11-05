import { RelayCoordinator } from '../src/index.mjs';

/** Test-only transaction store; production always uses the bound Durable Object. */
export class MemoryStorage {
  constructor() { this.values = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') for (const [name, item] of Object.entries(key)) this.values.set(name, structuredClone(item));
    else this.values.set(key, structuredClone(value));
  }
  async list(options = {}) { return new Map([...this.values].filter(([key]) => !options.startAfter || key > options.startAfter).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, options.limit || Infinity)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time) { this.alarm = time; }
  async transaction(callback) {
    const pending = this.queue.then(() => callback(this));
    this.queue = pending.catch(() => {}); return pending;
  }
}
export function createTestEnvironment({
  fetcher = globalThis.fetch.bind(globalThis), now = () => Date.now(),
  allowedOrigins = ['https://playground.example.com'],
  upstreamOrigins = ['https://first.example.com', 'https://second.example.com'],
  relayOrigin = 'https://relay.example.com', credentialOrigins = [],
  limits = {}, ...overrides
} = {}) {
  const env = {
    ENABLED: 'true', DEPLOYMENT_ENV: 'staging', RELAY_AUDIENCE: relayOrigin,
    ALLOWED_ORIGINS: JSON.stringify(allowedOrigins), UPSTREAM_ORIGINS: JSON.stringify(upstreamOrigins),
    CREDENTIAL_ORIGINS: JSON.stringify(credentialOrigins), POLICY_VERSION: '1',
    TURNSTILE_ACTION: 'network-session', TURNSTILE_SECRET_KEY: 'test-secret-for-injected-siteverify',
    LIMITS: JSON.stringify(limits), ...overrides,
  };
  const storage = new MemoryStorage(); const state = { storage };
  const coordinator = new RelayCoordinator(state, env, { fetcher, now, logger() {} });
  env.RELAY_STATE = { idFromName: name => name, get: () => ({ fetch: request => coordinator.fetch(request) }) };
  Object.defineProperties(env, { testStorage: { value: storage }, testCoordinator: { value: coordinator } });
  return env;
}
