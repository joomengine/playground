# Shared PHP networking implementation status

## Baseline

The implementation starts from `58b21b3d61c7415c231f8d180c388409b4910d74` on `main`. Previous PR #18 is closed and unmerged. Its component-specific mirror routing is not part of this branch. Useful regression coverage is adapted to the shared transport.

The existing `src/php-network.mjs` wrapper is called by both the PHP worker and debugger worker. HTTP streams use the native cURL adapter in `native/http-stream.c`. The recursive request guard must remain in place.

## Delivery boundary

The initial service uses direct HTTP access, then eligible fallback through an operator-controlled Cloudflare Worker, then a clear failure. Write requests select their route before dispatch. The hosted Worker permits reviewed upstream origins; broader unrestricted egress and a complete self-hosted service are outside this first deployment.

The relay remains disabled in the published default configuration until an operator provisions and validates a real endpoint. Repository implementation approval does not activate production.

## Required evidence

The PR records the exact tested commit, workflow links and browser receipts. Supported transport options and limitations are documented in [network.md](network.md). A successful unit test or archive creation does not establish a successful real Joomla/JCB workflow. Automated desktop WebKit is not physical mobile-device evidence. Hosted staging checks must not be reported as passed without executing against a deployed service.

## Validation and deployment boundary

Source checks, Worker security tests and actual workerd/SQLite tests run without deployment credentials. The CI candidate rebuilds the patched native extension, validates PHP cURL and streams, and exercises real browsers and Joomla/JCB workflows. The aggregate must pass for the final commit; an earlier successful run does not certify a later change.

The live JCB gate waits for the other validation jobs, then runs Chromium and
Firefox sequentially to avoid overlapping their requests to community
repositories. `scripts/test-jcb-network.mjs` permits at most two complete attempts
for a failed live-integration phase, with a short backoff. Each attempt starts a
new Node process, browser, Joomla installation and relay state; it never retries
a compile POST in a partially modified installation. The normal PHP execution
limit and all discovery, missing-Power, ZIP, installation and dashboard assertions
remain unchanged. Setup failures, missing receipts and process interruptions do
not qualify for a retry. A second failure fails the job and mandatory aggregate.
Attempt-specific artifacts and `test-results/jcb-network-attempts.json` retain
the first failure even when a later attempt succeeds. A recovered failure emits
a visible workflow warning rather than disappearing from the evidence.

Investigation on 6 November found an intermittent Firefox compiler HTTP 500 about
77 seconds into the compile phase, while a subsequent instrumented first attempt
passed in 18–19 seconds. The original receipt did not retain PHP stderr, so its
exact exception cannot be established retrospectively. The job already waited
for its completed build; a missing build dependency was not the cause. Receipts
now retain redacted PHP warnings, compiler-page text, bounded Joomla log tails,
and per-phase upstream/relay timings to diagnose any recurrence. Live integration
retries are CI behavior only; production request routing and write replay rules
are unchanged.

The static and demonstration-snapshot builds run with harmless, randomly generated server-credential canaries. Before publishing the candidate artifact, CI scans every public file and the expanded generated snapshots for raw and encoded canaries, rejects private Worker/configuration files, and verifies the normalized public network configuration. The retained security receipt identifies the source commit and inspected artifact counts without exposing canary values. Real deployment credentials are not available to this PR job.

The relay uses opaque sessions held in a Durable Object, so no session-signing secret is required. The operator still needs a private Turnstile verification secret, public widget settings, reviewed destination policy and a configured Cloudflare deployment account. Automated hosted staging additionally requires a private staging-test credential; production rejects that test mode. Default public configuration keeps the relay disabled.

The manually dispatched **Set up Cloudflare proxy** workflow automates initial
production provisioning using the repository Cloudflare token and account ID.
It creates or reuses the production widget, installs its private secret in the
Worker, provisions the SQLite Durable Object, and returns public endpoint/widget
settings. It creates no staging website and does not publish or enable the
Playground client. Reruns refuse active or unrelated Workers. See the
[GitHub setup instructions](../services/network-worker/README.md#set-up-production-from-github-actions).
The workflow's deterministic tests and dry runs do not establish a successful
deployment against the operator's account; that evidence comes from running it.

No hosted Cloudflare endpoint or physical mobile-device result is claimed by this branch. Those acceptance checks require provisioned infrastructure and actual devices. The protected staging workflow fails when required settings are missing. Hosted staging acceptance is required before merge, and production activation additionally requires successful hosted staging evidence from the same source commit. The repository owner must configure the required aggregate status and protected deployment environments; workflow YAML alone cannot enforce repository rules.

Live testing on 5 November 2026 found that JCB's default package-repository request to `git.vdm.dev` returns a genuine upstream HTTP 403 even from a server. The shared transport preserves it. The entity test records this default attempt, then selects an available package repository from the live discovery API through JCB's supported explicit repository argument. It imports real remote bytes and verifies the stored entity. Receipts identify the selected repository; production transport performs no repository substitution.
