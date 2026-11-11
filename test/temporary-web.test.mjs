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

test('ownership storage can recover without another create receipt', async () => {
  const f = fixture(), write = f.store.setItem;
  f.store.setItem = () => {throw Error('full');};
  await assert.rejects(f.chat.run('send',{text:'owned'}), /full/);
  f.store.setItem = write;
  f.chat.observe('https://chat.deepseek.com/a/chat/s/unrelated');
  await f.chat.capture();
  assert.equal(JSON.parse([...f.store.data.values()][0])[0].id, 'owned');
  await recoverTemporaryChats(f.chat.adapter, f.store);
  assert.deepEqual(f.removed, ['owned']);
});
test('corrupt cleanup data remains intact and never authorizes deletion', async () => {
  const f = fixture(), key = 'dsh-deepseek-workbench.pending-temporary.v1';
  for (const raw of ['{','{}','[{"id":"foreign"}]']) {
    f.store.setItem(key,raw); await assert.rejects(f.chat.run('send',{text:'x'}), /损坏/);
    assert.equal(f.store.getItem(key),raw); assert.deepEqual(f.removed,[]);
  }
});
test('successful creation with unknown ownership blocks close and cannot be replayed', async () => {
  let calls = 0;
  const service = {async createSession() {calls++; return {source:'unknown',session:{id:'ordinary'}};}};
  const controller = {sessionService:service, abortCompletion(){}, createSessionAndStartCompletion(){}, deleteSession(){assert.fail();}};
  const node = {__reactFiber$x:{memoizedProps:{value:{chatController:controller}}}};
  const env = {window:{},location:{origin:'https://chat.deepseek.com',pathname:'/'},document:{querySelector:()=>node,querySelectorAll:()=>[]}};
  const chat = new TemporaryWebChat({storage:storage()});
  await runInNewContext(temporaryScript({type:'arm',token:chat.token}),env);
  await service.createSession(); chat.armed = true;
  chat.adapter = {extract: script => runInNewContext(script,env)};
  await assert.rejects(chat.close(), /创建结果未知/);
  await assert.rejects(service.createSession()); assert.equal(calls,1); assert.equal(chat.closed,false);
});
