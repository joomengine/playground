# Shared PHP networking implementation status

## Baseline

The implementation starts from `58b21b3d61c7415c231f8d180c388409b4910d74` on `main`. Previous PR #18 is closed and unmerged. Its component-specific mirror routing is not part of this branch. Useful regression coverage will be adapted to the shared transport.

The existing `src/php-network.mjs` wrapper is called by both the PHP worker and debugger worker. HTTP streams use the native cURL adapter in `native/http-stream.c`. The recursive request guard must remain in place.

## Delivery boundary

The initial service uses direct HTTP access, then eligible fallback through an operator-controlled Cloudflare Worker, then a clear failure. Write requests select their route before dispatch. The hosted Worker permits reviewed upstream origins; broader unrestricted egress and a complete self-hosted service are outside this first deployment.

The relay remains disabled in the published default configuration until an operator provisions and validates a real endpoint. Repository implementation approval does not activate production.

## Required evidence

This document will be updated with the final commit's test results, supported PHP transport options, deployment state, and unresolved acceptance items. A successful unit test or archive creation does not establish a successful real Joomla/JCB workflow. Automated desktop WebKit is not physical mobile-device evidence. Hosted staging checks must not be reported as passed without executing against a deployed service.
