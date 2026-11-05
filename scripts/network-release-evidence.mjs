import assert from 'node:assert/strict';

/** Production must use the same reviewed commit that completed hosted staging. */
export function assertHostedStagingEvidence(run, jobs, commit) {
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  assert.equal(run.head_sha, commit, 'Staging must validate the same source commit as production.');
  assert.equal(run.path, '.github/workflows/network-staging.yml');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch');
  assert.ok(Array.isArray(jobs) && jobs.some(job => job.conclusion === 'success'
    && job.steps?.some(step => step.name === 'Verify hosted candidate' && step.conclusion === 'success')),
  'The staging run must include successful real hosted browser acceptance.');
}
