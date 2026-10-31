/** Coordinate tools sharing one site preview; detached windows own no grid area. */
export function createToolPanelGroup() {
  const members = new Map();
  let active;
  return {
    register(id, suspend) {
      if (members.has(id)) throw new Error('This tool panel is already registered.');
      members.set(id, suspend);
    },
    update(id, { visible, detached }) {
      if (!members.has(id)) throw new Error('This tool panel is not registered.');
      if (visible && !detached && active !== id) {
        const previous = active;
        active = id;
        if (previous !== undefined) members.get(previous)?.();
      } else if ((!visible || detached) && active === id) active = undefined;
      return active === id;
    },
    remove(id) {
      members.delete(id);
      if (active === id) active = undefined;
    },
    get active() { return active; },
    get size() { return members.size; },
  };
}

const groups = new WeakMap();
export function toolPanelGroup(host) {
  let group = groups.get(host);
  if (!group) { group = createToolPanelGroup(); groups.set(host, group); }
  return group;
}
