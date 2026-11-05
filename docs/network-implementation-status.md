# Shared PHP networking implementation status

## Baseline

The implementation starts from `58b21b3d61c7415c231f8d180c388409b4910d74` on `main`. Previous PR #18 is closed and unmerged. Its component-specific mirror routing is not part of this branch. Useful regression coverage will be adapted to the shared transport.

The existing `src/php-network.mjs` wrapper is called by both the PHP worker and debugger worker. HTTP streams use the native cURL adapter in `native/http-stream.c`. The recursive request guard must remain in place.

## Delivery boundary

The initial service uses direct HTTP access, then eligible fallback through an operator-controlled Cloudflare Worker, then a clear failure. Write requests select their route before dispatch. The hosted Worker permits reviewed upstream origins; broader unrestricted egress and a complete self-hosted service are outside this first deployment.

The relay remains disabled in the published default configuration until an operator provisions and validates a real endpoint. Repository implementation approval does not activate production.

## Required evidence

This document will be updated with the final commit's test results, supported PHP transport options, deployment state, and unresolved acceptance items. A successful unit test or archive creation does not establish a successful real Joomla/JCB workflow. Automated desktop WebKit is not physical mobile-device evidence. Hosted staging checks must not be reported as passed without executing against a deployed service.

## Implementation checkpoint

The first implementation checkpoint passes 529 source tests with zero failures or skips and JavaScript syntax checks under Node 26.12.1. The native cURL hook patch applies to its checksum-verified upstream source and its executable bridge checks pass. Compiled extension, real browser and JCB evidence must come from the candidate build, not these source checks.

The relay uses opaque sessions held in a Durable Object, so no session-signing secret is required. The operator still needs a private Turnstile verification secret, public widget settings, reviewed destination policy and a configured Cloudflare deployment account. Default public configuration keeps the relay disabled.
