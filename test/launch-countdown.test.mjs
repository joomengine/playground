import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLaunchCountdown, deploymentNeedsReview } from '../src/launch-countdown.mjs';

test('automatic launch counts down once and configuration cancels it', () => {
  let callback;
  let launches = 0;
  const ticks = [];
  const countdown = createLaunchCountdown({
    onTick: value => ticks.push(value), onLaunch: () => launches++,
    schedule: fn => { callback = fn; return 1; }, cancel: () => { callback = undefined; },
  });
  countdown.start();
  assert.deepEqual(ticks, [10]);
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
