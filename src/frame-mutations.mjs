/** Ignore DOM writes which leave the layout inputs unchanged after the batch. */
export function hasLayoutMutation(records) {
  const attributes = new Map();
  const text = new Map();
  for (const record of records) {
    if (record.type === 'childList' && (record.addedNodes.length || record.removedNodes.length)) return true;
    if (record.type === 'characterData' && !text.has(record.target)) text.set(record.target, record.oldValue);
    if (record.type !== 'attributes') continue;
    let previous = attributes.get(record.target);
    if (!previous) attributes.set(record.target, previous = new Map());
    // The first record is the value before this batch, not an intermediate write.
    if (!previous.has(record.attributeName)) previous.set(record.attributeName, record.oldValue);
  }
  for (const [target, previous] of attributes) {
    for (const [name, value] of previous) if (target.getAttribute(name) !== value) return true;
  }
  for (const [target, value] of text) if (target.data !== value) return true;
  return false;
}
