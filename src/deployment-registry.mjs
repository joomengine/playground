import { parseDeploymentDocument } from './config.mjs';

const ID = /^custom-[a-zA-Z0-9-]{8,64}$/;
const MAX_DEPLOYMENTS = 100;
const MAX_STORAGE_BYTES = 8 * 1024 * 1024;

export function deploymentRegistryKey(baseURL) {
  return `joomengine:deployments:${new URL(baseURL).href}`;
}

function deploymentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Enter a deployment name of 1–100 characters.');
  }
  return value.trim();
}

function record(value) {
  if (!value || !ID.test(value.id) || value.document?.schemaVersion !== 2) throw new TypeError('Invalid saved deployment.');
  const title = deploymentName(value.document.name);
  parseDeploymentDocument(value.document);
  return { id: value.id, title, document: structuredClone(value.document) };
}

/** Custom recipes are separate from saved Joomla installations and core presets. */
export function readDeploymentRegistry(storage, key) {
  const result = { schemaVersion: 1, deployments: [] };
  try {
    const raw = storage?.getItem(key);
    if (!raw || raw.length > MAX_STORAGE_BYTES) return result;
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || !Array.isArray(value.deployments)) return result;
    const ids = new Set();
    for (const entry of value.deployments.slice(0, MAX_DEPLOYMENTS)) {
      try {
        const next = record(entry);
        if (!ids.has(next.id)) { result.deployments.push(next); ids.add(next.id); }
      } catch { /* One damaged recipe must not hide the other saved recipes. */ }
    }
  } catch { /* Empty storage is valid until the visitor saves a deployment. */ }
  return result;
}

export function customDeploymentName(title, names = []) {
  const taken = new Set(names.map(name => String(name).trim().toLocaleLowerCase()));
  const base = `${String(title || 'Deployment').replace(/ Custom(?: \d+)?$/, '').slice(0, 85)} Custom`;
  let candidate = base, number = 2;
  while (taken.has(candidate.toLocaleLowerCase())) candidate = `${base} ${number++}`;
  return candidate;
}

/** Persist before returning new state, so a quota failure cannot report a save. */
function persist(storage, key, next) {
  const serialized = JSON.stringify(next);
  if (new TextEncoder().encode(serialized).byteLength > MAX_STORAGE_BYTES) throw new RangeError('Saved deployments exceed 8 MiB. Export or remove an older custom deployment.');
  if (!storage) throw new Error('Browser storage is unavailable. Export this deployment to keep it.');
  storage.setItem(key, serialized);
  return next;
}

export function saveCustomDeployment(storage, key, registry, document, { id, builtInNames = [] } = {}) {
  const title = deploymentName(document?.name);
  const existing = id && registry.deployments.find(entry => entry.id === id);
  if (id && !existing) throw new TypeError('Only an existing custom deployment can be replaced.');
  const reserved = [...builtInNames, ...registry.deployments.filter(entry => entry.id !== id).map(entry => entry.title)];
  if (reserved.some(name => name.trim().toLocaleLowerCase() === title.toLocaleLowerCase())) throw new TypeError('Choose a distinct name for this custom deployment.');
  if (!existing && registry.deployments.length >= MAX_DEPLOYMENTS) throw new RangeError('Save at most 100 custom deployments.');
  const entry = record({ id: existing?.id || `custom-${crypto.randomUUID()}`, document: { ...document, name: title } });
  const deployments = existing ? registry.deployments.map(item => item.id === entry.id ? entry : item) : [...registry.deployments, entry];
  return { registry: persist(storage, key, { schemaVersion: 1, deployments }), entry };
}

export function deleteCustomDeployment(storage, key, registry, id) {
  if (!registry.deployments.some(entry => entry.id === id)) throw new TypeError('Only custom deployments can be deleted.');
  return persist(storage, key, { schemaVersion: 1, deployments: registry.deployments.filter(entry => entry.id !== id) });
}
