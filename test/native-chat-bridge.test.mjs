import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { commandScript, statusScript } from '../src/client/native-chat-bridge.mjs';

function pageFixture() {
  let pressed = false, clicks = 0;
  const toggle = {
    textContent: '深度思考',
    // The DOM's original fiber can retain props from a previous render.
    __reactFiber$fixture: { memoizedProps: { enabled: true } },
    getAttribute: name => name === 'aria-pressed' ? String(pressed) : null,
    classList: { contains: () => false },
    click() { clicks++; pressed = !pressed; },
  };
  const input = { readOnly: true, parentElement: null };
  const context = {
    location: new URL('https://chat.deepseek.com/a/chat/s/existing'),
    document: {
      querySelector: () => input,
      querySelectorAll: selector => selector.includes('button') ? [toggle] : [],
    },
    setTimeout,
  };
  return { evaluate: script => runInNewContext(script, context), setPressed(value) { pressed = value; }, clicks: () => clicks };
}

test('new chat opens the official root without depending on sidebar controls', async () => {
  const page = pageFixture();
  assert.equal((await page.evaluate(commandScript({ type: 'new' }))).navigateTo, 'https://chat.deepseek.com/');
  assert.equal(page.clicks(), 0);
});

test('live pressed state wins over stale React owner props in both directions', () => {
  const page = pageFixture();
  assert.equal(page.evaluate(statusScript).think.enabled, false);
  page.setPressed(true);
  assert.equal(page.evaluate(statusScript).think.enabled, true);
  page.setPressed(false);
  assert.equal(page.evaluate(statusScript).think.enabled, false);
});

test('toggle commands confirm the requested state, remain idempotent and follow their own availability', async () => {
  const page = pageFixture();
  const enable = commandScript({ type: 'think', enabled: true });
  assert.equal((await page.evaluate(enable)).status.think.enabled, true);
  assert.equal((await page.evaluate(enable)).dispatched, false);
  assert.equal(page.clicks(), 1);
  assert.equal((await page.evaluate(commandScript({ type: 'think', enabled: false }))).status.think.enabled, false);
  assert.equal(page.clicks(), 2);
});
