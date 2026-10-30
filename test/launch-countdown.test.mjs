import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaunchCountdown, deploymentNeedsReview } from '../src/launch-countdown.mjs';

test('automatic launch counts down once and configuration cancels it', () => {
  let callback, delay;
  let launches = 0;
  const ticks = [];
  const countdown = createLaunchCountdown({
    onTick: value => ticks.push(value), onLaunch: () => launches++,
    schedule: (fn, milliseconds) => { callback = fn; delay = milliseconds; return 1; }, cancel: () => { callback = undefined; },
  });
  countdown.start();
  assert.deepEqual(ticks, [10]);
  assert.equal(delay, 1000);
  callback();
  assert.equal(ticks.at(-1), 9);
  const pending = callback;
  countdown.stop();
  pending();
  assert.equal(launches, 0);
  assert.equal(countdown.active, false);
  countdown.start();
  for (let i = 0; i < 10; i++) callback();
  assert.equal(ticks.at(-1), 0);
  assert.equal(launches, 0, 'The zero tick must be painted before launch hides its UI.');
  assert.equal(countdown.active, true, 'Stop must remain available during the final stage.');
  assert.equal(delay, 100);
  const finish = callback;
  finish();
  finish();
  assert.equal(launches, 1);
  assert.equal(countdown.active, false);
});

test('shared custom code and commands require review while catalog presets do not', () => {
  assert.equal(deploymentNeedsReview({ deployId: 'jcb' }), false);
  for (const input of [
    { extensions: [{ url: 'https://example.test/component.zip' }] },
    { template: { url: 'https://example.test/template.zip' } },
    { startupCommands: [['extension:install', '--url=https://example.test/component.zip']] },
    { languages: [{ tag: 'af-ZA', url: 'https://example.test/language.zip' }] },
    { content: { articles: [{ introtext: '<script>console.log("custom article")</script>' }] } },
    { menus: [{ title: 'Demo', component: 'com_demo' }] },
    { template: { params: { customHtml: '<script>console.log("template")</script>' } } },
  ]) assert.equal(deploymentNeedsReview(input), true);
});

test('a stale timer from a previous countdown cannot launch or change a restarted countdown', () => {
  const callbacks = [], ticks = [];
  let launches = 0;
  const countdown = createLaunchCountdown({ seconds: 1, onTick: value => ticks.push(value), onLaunch: () => launches++,
    schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel() {} });
  countdown.start();
  const stale = callbacks[0];
  countdown.stop();
  countdown.start();
  stale();
  assert.deepEqual(ticks, [1, 1]);
  assert.equal(launches, 0);
  callbacks[1]();
  assert.deepEqual(ticks, [1, 1, 0]);
  assert.equal(launches, 0);
  callbacks[2]();
  assert.equal(launches, 1);
});


test('Stop after zero cancels launch and an old final stage cannot launch a restarted countdown', () => {
  const callbacks = [], ticks = [];
  let launches = 0;
  const countdown = createLaunchCountdown({ seconds: 1, onTick: value => ticks.push(value), onLaunch: () => launches++,
    schedule: (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; }, cancel() {} });
  countdown.start();
  callbacks[0].callback();
  assert.deepEqual(ticks, [1, 0]);
  assert.equal(callbacks[1].delay, 100);
  const staleFinal = callbacks[1].callback;
  countdown.stop();
  staleFinal();
  assert.equal(launches, 0);
  countdown.start();
  staleFinal();
  assert.deepEqual(ticks, [1, 0, 1]);
  assert.equal(countdown.active, true);
  callbacks[2].callback();
  assert.deepEqual(ticks, [1, 0, 1, 0]);
  assert.equal(launches, 0);
  callbacks[3].callback();
  assert.equal(launches, 1);
  assert.equal(countdown.active, false);
});

test('a zero-tick observer can cancel before a final launch timer is scheduled', () => {
  let callback;
  let scheduled = 0, launches = 0;
  const countdown = createLaunchCountdown({ seconds: 1,
    onTick: value => { if (value === 0) countdown.stop(); }, onLaunch: () => launches++,
    schedule: fn => { scheduled++; callback = fn; return scheduled; }, cancel() {} });
  countdown.start();
  callback();
  assert.equal(scheduled, 1);
  assert.equal(launches, 0);
  assert.equal(countdown.active, false);
});
