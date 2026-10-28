/** Keep Joomla's document separate while allowing the outer page to own scrolling. */
export function connectFrame(frame, { onNavigate = () => {} } = {}) {
  let cleanupDocument = () => {};
  let observer, queued = false, measuring = false, needsMeasure = false, disposed = false, observedBodyHeight = 0, navigated = false;
  const minimum = () => Math.max(360, window.innerHeight - (document.body.classList.contains('embedded') ? 0 : document.getElementById('site-header')?.offsetHeight || 0));
  function measure() {
    if (disposed || measuring) return;
    queued = false;
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    if (!doc?.body || !doc.documentElement) return;
    measuring = true;
    observer?.disconnect();
    const base = minimum(), scroll = window.scrollY;
    // Use a known viewport height so CSS vh/min-height cannot grow recursively.
    frame.style.height = `${base}px`;
    frame.style.minHeight = `${base}px`;
    const height = Math.ceil(Math.max(base, doc.body.scrollHeight, doc.documentElement.scrollHeight, doc.body.getBoundingClientRect().height));
    frame.style.height = `${height}px`;
    observedBodyHeight = doc.body.getBoundingClientRect().height;
    if (Math.abs(window.scrollY - scroll) > 1) window.scrollTo({ top: scroll, behavior: 'instant' });
    requestAnimationFrame(() => { if (!disposed) { measuring = false; observer?.observe(doc.body); if (needsMeasure) { needsMeasure = false; schedule(); } } });
  }
  function schedule() { if (disposed || queued) return; if (measuring) { needsMeasure = true; return; } queued = true; requestAnimationFrame(measure); }
  function bringIntoView(element) {
    if (!element || element === frame.contentDocument?.body) return;
    const bounds = element.getBoundingClientRect(), top = frame.getBoundingClientRect().top + window.scrollY + bounds.top;
    if (top < window.scrollY + 12 || top + bounds.height > window.scrollY + window.innerHeight - 12) window.scrollTo({ top: Math.max(0, top - 24), behavior: 'instant' });
  }
  function loaded() {
    cleanupDocument(); observer?.disconnect();
    let doc, win;
    try { doc = frame.contentDocument; win = frame.contentWindow; } catch { return; }
    if (!doc?.body || !win) return;
    // Top-level Joomla extensions expect standalone parent behavior. Patch Tester's
    // popup-close callback reloads window.parent; keep that reload inside Joomla.
    // Nested modal frames retain their real Joomla parent browsing context.
    const originalParent = Object.getOwnPropertyDescriptor(win, 'parent');
    let parentReplaced = false;
    try { Object.defineProperty(win, 'parent', { configurable: true, value: win }); parentReplaced = true; } catch { /* Browsers without a replaceable parent keep native frame behavior. */ }
    frame.setAttribute('scrolling', 'no');
    doc.documentElement.style.overflowY = 'hidden';
    const style = doc.createElement('style');
    style.dataset.rocketHost = '';
    style.textContent = 'html{scroll-behavior:auto!important}.modal.show,.modal.in,.offcanvas.show{top:var(--rocket-visible-top,0px)!important;height:var(--rocket-visible-height,100vh)!important;bottom:auto!important}';
    doc.head?.append(style);
    // The frame is a document boundary, not a security sandbox for extension code.
    const changed = new MutationObserver(schedule);
    changed.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
    observer = new ResizeObserver(() => { if (!measuring && Math.abs(doc.body.getBoundingClientRect().height - observedBodyHeight) > 1) schedule(); });
    const viewport = () => {
      const bounds = frame.getBoundingClientRect();
      doc.documentElement.style.setProperty('--rocket-visible-top', `${Math.max(0, -bounds.top)}px`);
      doc.documentElement.style.setProperty('--rocket-visible-height', `${Math.max(200, Math.min(window.innerHeight, bounds.bottom) - Math.max(0, bounds.top))}px`);
    };
    window.addEventListener('scroll', viewport, { passive: true });
    window.addEventListener('resize', viewport);
    viewport();
    const focus = event => bringIntoView(event.target);
    const hash = () => { let id; try { id = decodeURIComponent(win.location.hash.slice(1)); } catch { return; } if (id) bringIntoView(doc.getElementById(id)); };
    doc.addEventListener('load', schedule, true); doc.addEventListener('focusin', focus);
    win.addEventListener('hashchange', hash);
    doc.fonts?.ready.then(schedule).catch(() => {});
    cleanupDocument = () => {
      if (parentReplaced) { try { if (win.document === doc) { if (originalParent) Object.defineProperty(win, 'parent', originalParent); else delete win.parent; } } catch { /* A cross-origin navigation owns its new document. */ } }
      changed.disconnect(); observer?.disconnect(); style.remove(); doc.removeEventListener('load', schedule, true); doc.removeEventListener('focusin', focus); win.removeEventListener('hashchange', hash); window.removeEventListener('scroll', viewport); window.removeEventListener('resize', viewport); };
    try { onNavigate({ url: win.location.href, title: doc.title, administrator: /\/administrator\//.test(win.location.pathname), signedOut: Boolean(doc.querySelector('form#form-login, form#login-form, input[name="passwd"]')) }); } catch { /* Cross-origin navigation cannot expose its document. */ }
    if (navigated && !win.location.hash) window.scrollTo({ top: Math.max(0, frame.getBoundingClientRect().top + window.scrollY), behavior: 'instant' });
    navigated = true;
    schedule(); requestAnimationFrame(hash);
  }
  frame.addEventListener('load', loaded); window.addEventListener('resize', schedule);
  frame.style.height = `${minimum()}px`;
  return () => { disposed = true; cleanupDocument(); observer?.disconnect(); frame.removeEventListener('load', loaded); window.removeEventListener('resize', schedule); };
}
