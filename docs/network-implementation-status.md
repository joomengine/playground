# Shared PHP networking implementation status

## Baseline

The implementation starts from `58b21b3d61c7415c231f8d180c388409b4910d74` on `main`. Previous PR #18 is closed and unmerged. Its component-specific mirror routing is not part of this branch. Useful regression coverage will be adapted to the shared transport.

The existing `src/php-network.mjs` wrapper is called by both the PHP worker and debugger worker. HTTP streams use the native cURL adapter in `native/http-stream.c`. The recursive request guard must remain in place.

## Delivery boundary

The initial service uses direct HTTP access, then eligible fallback through an operator-controlled Cloudflare Worker, then a clear failure. Write requests select their route before dispatch. The hosted Worker permits reviewed upstream origins; broader unrestricted egress and a complete self-hosted service are outside this first deployment.

The relay remains disabled in the published default configuration until an operator provisions and validates a real endpoint. Repository implementation approval does not activate production.

## Required evidence

The PR records the exact tested commit, workflow links and browser receipts. Supported transport options and limitations are documented in [network.md](network.md). A successful unit test or archive creation does not establish a successful real Joomla/JCB workflow. Automated desktop WebKit is not physical mobile-device evidence. Hosted staging checks must not be reported as passed without executing against a deployed service.

## Validation and deployment boundary

Source checks, Worker security tests and actual workerd/SQLite tests run without deployment credentials. The CI candidate rebuilds the patched native extension, validates PHP cURL and streams, and exercises real browsers and Joomla/JCB workflows. The aggregate must pass for the final commit; an earlier successful run does not certify a later change.

The relay uses opaque sessions held in a Durable Object, so no session-signing secret is required. The operator still needs a private Turnstile verification secret, public widget settings, reviewed destination policy and a configured Cloudflare deployment account. Automated hosted staging additionally requires a private staging-test credential; production rejects that test mode. Default public configuration keeps the relay disabled.

No hosted Cloudflare endpoint or physical mobile-device result is claimed by this branch. Those release checks require provisioned infrastructure and actual devices. The protected staging workflow fails when required settings are missing; production activation requires successful hosted staging evidence from the same source commit.

Live testing on 5 November 2026 found that JCB's default package-repository request to `git.vdm.dev` returns a genuine upstream HTTP 403 even from a server. The shared transport preserves it. The entity test records this default attempt, then selects an available package repository from the live discovery API through JCB's supported explicit repository argument. It imports real remote bytes and verifies the stored entity. Receipts identify the selected repository; production transport performs no repository substitution.
