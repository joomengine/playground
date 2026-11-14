import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeWorkerError } from '../src/worker-errors.mjs';

test('empty-message quota errors retain an explicit failure and original identity', () => {
  const result = serializeWorkerError(new DOMException('', 'QuotaExceededError'));
  assert.equal(result.name, 'QuotaExceededError');
  assert.equal(result.code, 22);
  assert.match(result.error, /Browser storage rejected the write/);
});

test('worker failures preserve meaningful messages and normalize non-Error rejections', () => {
  assert.deepEqual(serializeWorkerError(Object.assign(new Error('Cannot write file'), { code: 'EIO' })),
    { error: 'Cannot write file', name: 'Error', code: 'EIO' });
  for (const cause of [undefined, null, '', new Error('')]) {
    assert.equal(serializeWorkerError(cause, 'Save failed.').error, 'Save failed.');
  }
  assert.equal(serializeWorkerError('Unavailable').error, 'Unavailable');
  assert.equal(serializeWorkerError(new DOMException('', 'InvalidStateError')).name, 'InvalidStateError');
});
