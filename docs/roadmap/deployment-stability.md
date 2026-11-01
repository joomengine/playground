# Deployment stability

Implementation scope for the deployment configuration changes. Completion is recorded in the pull request after validation.

- Send user-supplied extension and template URLs to Joomla's existing `extension:install --url` command. Keep the shipped Joomla and maintained package installation paths.
- Record custom installation errors, continue the remaining setup, and open the site with those errors available. Do not add a download service or wrapper archive/checksum inspection for custom URLs.
- Use the same deployment requirements for selection and launch. Require JCB only where needed, resolve compatible optional JCB packages, and allow Joomla development-version fallbacks only when declared.
- Populate the complete deployment configuration on selection. Clone maintained definitions when edited; save, rename and delete custom definitions in the browser.
- Provide complete JSON import/export and basic inputs alongside advanced JSON. Keep runtime selection on the dashboard.
- Reuse maintained and successfully built custom images from browser storage. Follow the existing server manifest hashes for maintained image updates; keep saved sites independent of cached images.
- Separate image building from launching. Provide local image listing/deletion and generic progress messages without internal asset URLs.
- Use the deployment editor to create independent sites, keep countdown controls icon-only, and submit the displayed Joomla login form from Login details.
- Activate the mobile isolation fallback independently of the optional image relay.
- Restore complete site downloads through dashboard Upload, preserving edited files, database, known credentials and opening page under an independent saved-site identity.
- Include a payload hash in complete exports, excluding the metadata itself. Verify it when present and continue importing older hashless exports with a short notice.
- Remove superseded code paths and update documentation to match the finished behavior.

Validation covers maintained deployment selection, required/optional JCB, custom CLI success and failure, persistence and JSON round trips, image reuse/invalidation/deletion, complete site export/upload, independent copies, login, mobile startup, and the repository checks. The reported GitHub archive must be exercised through actual browser PHP; a server-side download alone does not establish browser installation success.
