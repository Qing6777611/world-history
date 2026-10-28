import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobeLifetime } from '../app/globe-lifecycle.ts';

test('partial globe startup aborts requests and releases acquired resources in reverse order', () => {
  const lifetime = createGlobeLifetime();
  const released = [];
  lifetime.signal.addEventListener('abort', () => released.push('request'));
  lifetime.add(() => released.push('renderer'));
  lifetime.add(() => released.push('sky'));
  lifetime.add(() => released.push('observer'));
  lifetime.dispose();
  lifetime.dispose();
  assert.equal(lifetime.signal.aborted, true);
  assert.deepEqual(released, ['request', 'observer', 'sky', 'renderer']);
});

test('a failing cleanup does not leave the renderer alive', () => {
  const errors = [];
  const lifetime = createGlobeLifetime(error => errors.push(error));
  let rendererReleased = false;
  const failure = new Error('texture cleanup failed');
  lifetime.add(() => { rendererReleased = true; });
  lifetime.add(() => { throw failure; });
  lifetime.dispose();
  assert.equal(rendererReleased, true);
  assert.deepEqual(errors, [failure]);
});

test('resources that finish loading after unmount are immediately released', () => {
  const lifetime = createGlobeLifetime();
  lifetime.dispose();
  let released = 0;
  lifetime.add(() => { released += 1; });
  lifetime.dispose();
  assert.equal(released, 1);
});
