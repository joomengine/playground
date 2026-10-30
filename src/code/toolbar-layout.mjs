/** Fit action text to the space actually left between identity and window controls.
 * Keep the original buttons mounted so resizing never changes focus or handlers.
 */
export function fitToolbarActions(root, toolbar) {
  const win = toolbar.ownerDocument.defaultView;
  const controls = [...toolbar.children].filter(control => control.querySelector('.je-action-label')
    && !control.classList.contains('je-icon-only') && !control.hidden);
  for (const control of controls) control.classList.remove('jec-action-icon');
  root.dataset.actions = 'labels';
  if (toolbar.scrollWidth <= toolbar.clientWidth + 1) return;

  const widths = controls.map(control => control.getBoundingClientRect().width);
  for (const control of controls) control.classList.add('jec-action-icon');
  if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
    root.dataset.actions = 'strip';
    return;
  }
  const style = win.getComputedStyle(toolbar);
  const children = [...toolbar.children].filter(control => {
    const computed = win.getComputedStyle(control);
    return computed.display !== 'none' && !['absolute', 'fixed'].includes(computed.position);
  });
  const used = children.reduce((width, control) => {
    const computed = win.getComputedStyle(control);
    return width + control.getBoundingClientRect().width
      + (parseFloat(computed.marginLeft) || 0) + (parseFloat(computed.marginRight) || 0);
  }, 0) + Math.max(0, children.length - 1) * (parseFloat(style.columnGap) || 0);
  let available = toolbar.clientWidth - (parseFloat(style.paddingLeft) || 0)
    - (parseFloat(style.paddingRight) || 0) - used;
  const extra = controls.map((control, index) => Math.max(0, widths[index] - control.getBoundingClientRect().width));
  // A cramped dock remains a consistent row of icons. Wider areas regain useful
  // labels progressively instead of losing every word when one label overflows.
  const minimum = [...extra].sort((a, b) => a - b).slice(0, 2).reduce((sum, width) => sum + width, 0);
  let visible = 0;
  if (available >= minimum) for (const [index, control] of controls.entries()) {
    if (extra[index] > available + 1) continue;
    control.classList.remove('jec-action-icon');
    if (toolbar.scrollWidth > toolbar.clientWidth + 1) control.classList.add('jec-action-icon');
    else { available -= extra[index]; visible++; }
  }
  root.dataset.actions = visible ? 'mixed' : 'icons';
}
