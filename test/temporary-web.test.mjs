import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { statusScript } from '../src/client/native-chat-bridge.mjs';
import { TemporaryWebChat, temporaryScript, recoverTemporaryChats } from '../src/client/temporary-web.mjs';
const storage = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; };
function fixture() {
  const store = storage(), chat = new TemporaryWebChat({ storage: store }), removed = [];
  let createdId = null; let url = 'https://chat.deepseek.com/', fail = false, wait;
  chat.adapter = { async extract(script) {
    if (script === statusScript) return { url };
    if (script.includes('"type":"arm"')) return { ready: true };
    if (script.includes('"type":"owned"')) return { id: createdId, pending: false };
    if (script.includes('"type":"probe"')) return { ready: true };
    if (script.includes('"type":"send"')) { await wait; createdId = 'owned'; url = 'https://chat.deepseek.com/a/chat/s/owned'; chat.observe(url); return { dispatched: true, accepted: true }; }
    if (script.includes('"type":"delete"')) { if (fail) throw Error('offline'); removed.push('owned'); return { deleted: true, id: 'owned' }; }
    throw Error('unexpected request');
  } };
  return { chat, store, removed, setFail: value => { fail = value; }, setUrl: value => { url = value; }, setWait: value => { wait = value; } };
}
test('close drains the in-flight first send and deletes only its owned conversation', async () => {
  const f = fixture(), deferred = Promise.withResolvers(); f.setWait(deferred.promise);
  const sending = f.chat.run('send', { text: 'synthetic' });
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.chat.close(); assert.equal(f.chat.closing, true); assert.equal(f.chat.closed, false);
  deferred.resolve(); await sending; await closing;
  assert.deepEqual(f.removed, ['owned']); assert.equal(f.chat.closed, true); assert.equal(f.store.data.size, 0);
});
test('failed cleanup retains the ticket, refuses sends and supports a verified retry', async () => {
  const f = fixture(); await f.chat.run('send', { text: 'synthetic' }); f.setFail(true);
  await assert.rejects(f.chat.close(), /offline/); assert.equal(f.chat.closed, false); assert.equal(f.store.data.size, 1);
  f.setFail(false); await f.chat.close(); assert.equal(f.store.data.size, 0); assert.deepEqual(f.removed, ['owned']);
});
test('opening an existing official history never claims or deletes that history', async () => {
  const f = fixture(); f.setUrl('https://chat.deepseek.com/a/chat/s/existing');
  await assert.rejects(f.chat.run('send', { text: 'synthetic' }), /离开自己的页面/);
  await f.chat.close(); assert.deepEqual(f.removed, []);
});
test('official controller deletion must acknowledge the exact owned id', async () => {
  const deleted = [], controller = { abortCompletion() {}, createSessionAndStartCompletion() {}, async deleteSession(id) { deleted.push(id); return true; } };
  const input = { __reactFiber$fixture: { dependencies: { firstContext: { memoizedValue: { chatController: controller } } } } };
  const env = { window: {}, Symbol, location: { origin: 'https://chat.deepseek.com' }, document: { querySelector: () => input, querySelectorAll: () => [] } };
  const result = await runInNewContext(temporaryScript({ type: 'delete', id: 'owned' }), env);
  assert.equal(result.deleted, true); assert.deepEqual(deleted, ['owned']);
  controller.deleteSession = async () => false;
  await assert.rejects(runInNewContext(temporaryScript({ type: 'delete', id: 'owned' }), env), /尚未确认删除/);
});
test('crash cleanup skips live owners and clears only successful recorded deletions', async () => {
  const f = fixture(); await f.chat.run('send', { text: 'synthetic' });
  await recoverTemporaryChats(f.chat.adapter, f.store, new Set([f.chat.token])); assert.deepEqual(f.removed, []);
  await recoverTemporaryChats(f.chat.adapter, f.store); assert.deepEqual(f.removed, ['owned']); assert.equal(f.store.data.size, 0);
});
test('an unacknowledged send followed by old-history navigation cannot acquire that history', async () => {
  const store = storage(), chat = new TemporaryWebChat({ storage: store }), deleted = [];
  let url = 'https://chat.deepseek.com/';
  chat.adapter = { async extract(script) {
    if (script === statusScript) return { url };
    if (script.includes('"type":"owned"')) return { id: null, started: false, pending: false };
    if (script.includes('"type":"send"')) return { dispatched: true, accepted: false };
    if (script.includes('"type":"delete"')) deleted.push(script);
    return { ready: true };
  } };
  await chat.run('send', { text: 'synthetic' });
  url = 'https://chat.deepseek.com/a/chat/s/existing';
  chat.observe(url); await chat.close();
  assert.deepEqual(deleted, []); assert.equal(store.data.size, 0);
});
test('the official create receipt is captured and the guest cannot create a second chat', async () => {
  const controller = { abortCompletion() {}, createSessionAndStartCompletion() {}, deleteSession() {},
    sessionService: { async createSession() { return { source: 'pre_create', session: { id: 'new-receipt' } }; } } };
  const input = { __reactFiber$fixture: { dependencies: { firstContext: { memoizedValue: { chatController: controller } } } } };
  const env = { window: {}, Symbol, location: { origin: 'https://chat.deepseek.com', pathname: '/' },
    document: { querySelector: () => input, querySelectorAll: () => [] } };
  await runInNewContext(temporaryScript({ type: 'arm', token: 'test' }), env);
  await controller.sessionService.createSession();
  const receipt = await runInNewContext(temporaryScript({ type: 'owned', token: 'test' }), env);
  assert.equal(receipt.id, 'new-receipt');
  await assert.rejects(controller.sessionService.createSession(), /只允许创建一个/);
});
