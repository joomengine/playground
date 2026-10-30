import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeFrameNavigation } from '../src/frame-view.mjs';
import { safeSavedRoute } from '../src/ui-state.mjs';

function frameWindow() {
  const win = new EventTarget();
  win.location = new URL('https://playground.test/site/administrator/');
  win.document = { title: 'Joomla', querySelector: () => null };
  const calls = [];
  const history = Object.create({
    pushState(state, unused, url) {
      if (this !== history) throw new TypeError('Illegal invocation');
      const next = new URL(url ?? win.location.href, win.location);
      if (next.origin !== win.location.origin) throw new DOMException('Invalid origin', 'SecurityError');
      calls.push({ state, unused, url }); win.location = next;
      return 'native-result';
    },
    replaceState(...args) { return Reflect.apply(Object.getPrototypeOf(history).pushState, this, args); },
  });
  win.history = history;
  return { win, history, calls };
}

test('frame navigation observes history, hash and back routes without rewriting native state or URLs', () => {
  const { win, history, calls } = frameWindow();
  const events = [], stop = observeFrameNavigation(win, event => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].administrator, true);
  const state = { article: 42 };
  const actionRoute = '/site/administrator/index.php?option=com_content&view=article&id=42&task=article.save&token=secret#details';
  assert.equal(history.pushState(state, '', actionRoute), 'native-result');
  assert.equal(calls[0].state, state);
  assert.equal(win.location.pathname + win.location.search + win.location.hash, actionRoute, 'Observing cannot alter Joomla form/action navigation.');
  const saved = safeSavedRoute(events.at(-1).url.slice('https://playground.test/site'.length));
  assert.equal(saved, '/administrator/index.php?option=com_content&view=article&id=42#details', 'Only persistence removes transient action/security state.');
  history.replaceState(null, '', '/site/');
  assert.equal(events.at(-1).administrator, false);
  win.location.hash = '#article-42'; win.dispatchEvent(new Event('hashchange'));
  assert.match(events.at(-1).url, /#article-42$/);
  win.location = new URL('https://playground.test/site/administrator/'); win.dispatchEvent(new Event('popstate'));
  assert.equal(events.at(-1).administrator, true);
  const count = events.length; win.dispatchEvent(new Event('hashchange'));
  assert.equal(events.length, count, 'Duplicate events for one URL are not emitted.');
  assert.throws(() => history.pushState(null, '', 'https://unrelated.test/'), { name: 'SecurityError' });
  assert.throws(() => history.pushState.call({}, null, '', '/site/'), /Illegal invocation/);
  assert.equal(events.length, count, 'Failed native navigation is never reported as successful.');
  stop();
  assert.equal(Object.hasOwn(history, 'pushState'), false);
  history.pushState(null, '', '/site/'); win.dispatchEvent(new Event('popstate'));
  assert.equal(events.length, count, 'Disposal detaches both history and event observers.');
});

test('disposing a navigation observer preserves later Joomla history wrappers', () => {
  const { win, history } = frameWindow();
  let notifications = 0;
  const stop = observeFrameNavigation(win, () => { notifications++; });
  const observed = history.pushState;
  const extensionWrapper = function (...args) { return observed.apply(this, args); };
  history.pushState = extensionWrapper;
  stop();
  assert.equal(history.pushState, extensionWrapper);
  history.pushState(null, '', '/site/');
  assert.equal(notifications, 1, 'An extension-retained wrapper becomes passive after disposal.');
});

test('navigation notification errors never replace the successful native history result', () => {
  const { win, history } = frameWindow();
  const stop = observeFrameNavigation(win, () => { throw new Error('Observer failed'); });
  assert.equal(history.replaceState(null, '', '/site/'), 'native-result');
  stop();
});
