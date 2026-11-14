import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { createLaunchMedia } from '../src/launch-media.mjs';

const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const functionSource = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function mediaFixture(play) {
  const document = new EventTarget();
  document.hidden = false;
  const motion = new EventTarget();
  motion.matches = false;
  const video = { hidden: true, paused: true, plays: 0, pauses: 0,
    play() { this.plays++; this.paused = false; return play ? play() : Promise.resolve(); },
    pause() { this.pauses++; this.paused = true; },
  };
  const poster = { hidden: false };
  const media = createLaunchMedia({ video, poster, document, motion });
  return { video, poster, document, motion, media };
}

test('launch media waits for launch, plays once and stops when launch leaves the screen', () => {
  const { media, video, poster } = mediaFixture();
  assert.equal(video.plays, 0);
  assert.equal(poster.hidden, false);
  media.setActive(true);
  assert.equal(video.plays, 1);
  assert.equal(video.paused, false);
  assert.equal(video.hidden, false);
  assert.equal(poster.hidden, true);
  media.setActive(true);
  assert.equal(video.plays, 1, 'Repeated loading updates must not restart the video.');
  media.setActive(false);
  assert.equal(video.paused, true);
  assert.equal(video.hidden, true);
  assert.equal(poster.hidden, false);
  media.setActive(true);
  assert.equal(video.plays, 2, 'A later launch can play again.');
  media.dispose();
  assert.equal(video.paused, true);
});

test('hidden tabs and reduced motion pause playback and resume only an active launch', () => {
  const { media, video, poster, document, motion } = mediaFixture();
  motion.matches = true;
  media.setActive(true);
  assert.equal(video.plays, 0);
  assert.equal(poster.hidden, false);
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  assert.equal(video.plays, 1);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(video.paused, true);
  assert.equal(poster.hidden, false);
  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(video.plays, 2);
  motion.matches = true;
  motion.dispatchEvent(new Event('change'));
  assert.equal(video.paused, true);
  media.setActive(false);
  motion.matches = false;
  motion.dispatchEvent(new Event('change'));
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(video.plays, 2, 'Visibility changes cannot restart an ended launch.');
  media.dispose();
});

test('rejected playback keeps the poster and stale rejections cannot hide a newer launch', async () => {
  const rejections = [];
  const { media, video, poster } = mediaFixture(() => new Promise((_, reject) => rejections.push(reject)));
  media.setActive(true);
  rejections[0](new Error('Playback unavailable'));
  await Promise.resolve();
  assert.equal(video.hidden, true);
  assert.equal(poster.hidden, false);
  media.setActive(false);
  media.setActive(true);
  media.setActive(false);
  media.setActive(true);
  rejections[1](new Error('Superseded play request'));
  await Promise.resolve();
  assert.equal(video.hidden, false);
  assert.equal(poster.hidden, true);
  media.dispose();
  rejections[2](new Error('Disposed play request'));
  await Promise.resolve();
  assert.equal(video.hidden, true);
  assert.equal(poster.hidden, false);
});

test('disposing removes media listeners and prevents later restarts', () => {
  const { media, video, document, motion } = mediaFixture();
  media.setActive(true);
  media.dispose();
  document.dispatchEvent(new Event('visibilitychange'));
  motion.dispatchEvent(new Event('change'));
  assert.equal(video.plays, 1);
  assert.equal(video.paused, true);
});

function appFixture({ valid = true, runtime, check = async () => true, resolve, createPlayground } = {}) {
  const fixture = mediaFixture();
  const nodes = new Map([
    ['launch-video', fixture.video], ['launch-image-poster', fixture.poster],
  ]);
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', value: '',
      removeAttribute() {}, checkValidity: () => valid, reportValidity() {}, focus() {},
    });
    return nodes.get(id);
  };
  $(runtime ? 'site-mount' : 'welcome').hidden = false;
  fixture.document.querySelector = () => ({ classList: { toggle() {} } });
  const input = { storageKey: 'launch-media-test', persistence: true, deployId: 'blank', joomlaVersion: '6.0', phpVersion: '8.4' };
  const context = vm.createContext({
    $, document: fixture.document, launchMedia: fixture.media,
    busy: false, launching: false, initialized: true, catalog: {}, deployCatalog: {}, runtime,
    stoppedSite: undefined, readLiveMetadata: () => null, backupPanel: null, requireOwnerForReplacement: () => true,
    launchCountdown: { stop() {} }, buildUpdates: { check },
    setBusy(value) { context.busy = value; }, setDrawer() {}, openDialog() {},
    clearFeedback() {}, feedback() {}, activity() {}, t: value => value, messageOf: String,
    formInput: () => input, dynamicMetadata: { joomla: [] },
    freshKeyPending: false, savedState: { sites: {} },
    isolateSetup: async (_, configuration) => ({ configuration, changed: false }),
    resolve: resolve || (async configuration => ({ configuration })),
    publicConfiguration: value => value, currentConfig: runtime ? input : undefined,
    currentInput: runtime ? input : undefined,
    fields: { storageKey: { value: input.storageKey } }, resumeLastRoute: false,
    createPlayground: createPlayground || (() => { throw new Error('Unexpected runtime start'); }),
    destroyPreview() {}, displayError() { context.show('error-view'); },
  });
  vm.runInContext([
    functionSource('function show(view)', 'function feedback('),
    functionSource('function progress(event)', 'function displayError('),
    functionSource('async function launch(', 'async function closeSite('),
  ].join('\n'), context);
  return { ...fixture, $, context };
}

test('accepted launch starts playback before its asynchronous update check and restores welcome when blocked', async () => {
  let release;
  const fixture = appFixture({ check: () => new Promise(resolve => { release = resolve; }) });
  const pending = fixture.context.launch();
  assert.equal(fixture.$('loading-view').hidden, false);
  assert.equal(fixture.video.plays, 1, 'Playback starts before the first network await.');
  assert.equal(fixture.video.paused, false);
  release(true);
  await pending;
  assert.equal(fixture.$('welcome').hidden, false);
  assert.equal(fixture.$('loading-view').hidden, true);
  assert.equal(fixture.video.paused, true);
  assert.equal(fixture.poster.hidden, false);
});

test('invalid setup and opening an already running site do not start launch media', async () => {
  const invalid = appFixture({ valid: false });
  await invalid.context.launch();
  assert.equal(invalid.video.plays, 0);
  assert.equal(invalid.$('welcome').hidden, false);
  const running = appFixture({ runtime: {}, check: async () => false });
  await running.context.launch();
  assert.equal(running.video.plays, 0);
  assert.equal(running.$('site-mount').hidden, false);
});

test('preflight errors and runtime failures stop launch media', async () => {
  const preflight = appFixture({ check: async () => { throw new Error('Check failed'); } });
  await preflight.context.launch();
  assert.equal(preflight.video.plays, 1);
  assert.equal(preflight.$('welcome').hidden, false);
  assert.equal(preflight.video.paused, true);
  const runtime = appFixture({ check: async () => false,
    createPlayground: async () => { throw new Error('Runtime failed'); },
  });
  await runtime.context.launch();
  assert.equal(runtime.$('error-view').hidden, false);
  assert.equal(runtime.video.paused, true);
  assert.equal(runtime.poster.hidden, false);
});

test('all preparation phases keep the launch video playing until the site is displayed', () => {
  const fixture = appFixture();
  fixture.context.launching = true;
  fixture.context.show('loading-view');
  for (const phase of ['assets', 'database', 'php', 'download-image', 'build-image', 'save-image', 'launch-image', 'ready']) {
    fixture.context.progress({ phase, message: phase });
    assert.equal(fixture.video.plays, 1, `${phase} must not restart playback.`);
    assert.equal(fixture.video.paused, false, `${phase} must not pause playback.`);
    assert.equal(fixture.video.hidden, false);
  }
  fixture.context.show('site-mount');
  assert.equal(fixture.video.paused, true);
  assert.equal(fixture.poster.hidden, false);
  fixture.context.launching = false;
  fixture.context.show('loading-view');
  assert.equal(fixture.video.plays, 1, 'Unrelated loading operations must retain the poster.');
});

test('the landing page preloads muted inline launch media without autoplaying it', () => {
  const video = html.match(/<video\b[^>]*id="launch-video"[^>]*>/)?.[0];
  assert.ok(video);
  assert.match(video, /preload="auto"/);
  assert.match(video, /\bmuted\b/);
  assert.match(video, /\bplaysinline\b/);
  assert.doesNotMatch(video, /\bautoplay\b/);
});
