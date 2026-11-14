/**
 * Once worker shutdown starts, an error cannot be presented as a live site.
 * Preserve that distinction from a pre-close save rejection, which leaves both
 * workers available. A reset still attempts deletion after shutdown errors.
 */
export async function closeSiteResources({ closePhp, closeDatabase, erase, release, lastSavedAt = null }) {
  let failure, erased = false;
  try {
    try { await closePhp?.(); } catch (error) { failure = error; }
    try { await closeDatabase?.(); } catch (error) { failure ??= error; }
    if (erase) {
      try { await erase(); erased = true; failure = undefined; }
      catch (error) { failure = error; }
    }
  } finally {
    try { await release?.(); } catch (error) { failure ??= error; }
  }
  if (failure) {
    const detail = typeof failure?.message === 'string' && failure.message.trim() ? failure.message : 'Storage cleanup did not complete.';
    const saved = lastSavedAt ? ` The last confirmed save was ${lastSavedAt}.` : '';
    const error = new Error(`The site is closed, but its shutdown did not complete cleanly.${saved} ${detail}`, { cause: failure });
    Object.assign(error, { code: 'SITE_CLOSE_FAILED', closed: true, erased, lastSavedAt });
    throw error;
  }
  return { closed: true, erased, lastSavedAt };
}
