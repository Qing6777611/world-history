import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as THREE from 'three';
import { createGlobeSky } from '../app/globe-sky.ts';

function browser(t, { idle = true } = {}) {
  const previous = globalThis.window;
  const timers = new Map(), idleCallbacks = new Map();
  let nextId = 0;
  globalThis.window = {
    setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false }),
    ...(idle ? {
      requestIdleCallback(callback) { const id = ++nextId; idleCallbacks.set(id, callback); return id; },
      cancelIdleCallback(id) { idleCallbacks.delete(id); },
    } : {}),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const run = queue => {
    const pending = [...queue.values()];
    queue.clear();
    for (const callback of pending) callback();
  };
  return { timers, idleCallbacks, delay: () => run(timers), idle: () => run(idleCallbacks) };
}

test('the decorative sky waits for the map and releases its texture on dispose', async t => {
  const scheduler = browser(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url);
    return new Response('image bytes');
  });
  let released = 0;
  class TextureLoader {
    load(_url, onLoad) {
      const texture = new THREE.Texture();
      texture.addEventListener('dispose', () => { released += 1; });
      queueMicrotask(() => onLoad(texture));
      return texture;
    }
  }
  const scene = new THREE.Scene();
  const sky = createGlobeSky({ ...THREE, TextureLoader }, scene, new THREE.PerspectiveCamera());
  assert.equal(requests.length, 0);
  assert.equal(scene.getObjectByName('atlas-star-field').visible, false);
  scheduler.delay();
  assert.equal(requests.length, 0);
  scheduler.idle();
  await setImmediate();
  assert.deepEqual(requests, ['/textures/night-sky.png']);
  assert.equal(scene.getObjectByName('atlas-star-field').visible, true);
  sky.dispose();
  sky.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(released, 1);
});

test('unmount before the texture delay prevents the request entirely', t => {
  const scheduler = browser(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('image bytes'));
  const scene = new THREE.Scene();
  const sky = createGlobeSky(THREE, scene, new THREE.PerspectiveCamera());
  sky.dispose();
  scheduler.delay();
  scheduler.idle();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(scheduler.timers.size, 0);
  assert.equal(scene.children.length, 0);
});

test('unmount aborts a texture request that has already started', async t => {
  const scheduler = browser(t, { idle: false });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const scene = new THREE.Scene();
  const sky = createGlobeSky(THREE, scene, new THREE.PerspectiveCamera());
  scheduler.delay();
  assert.equal(requestSignal.aborted, false);
  sky.dispose();
  await setImmediate();
  assert.equal(requestSignal.aborted, true);
  assert.equal(scene.children.length, 0);
});

test('an exception during sky setup releases earlier resources and cancels deferred work', t => {
  const scheduler = browser(t);
  const scene = new THREE.Scene();
  class PlaneGeometry {
    constructor() { throw new Error('simulated allocation failure'); }
  }
  assert.throws(() => createGlobeSky({ ...THREE, PlaneGeometry }, scene, new THREE.PerspectiveCamera()), /allocation failure/);
  assert.equal(scene.children.length, 0);
  assert.equal(scheduler.timers.size, 0);
});
