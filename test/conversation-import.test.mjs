import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationImport } from '../src/client/conversation-import.mjs';

const conversation = signature => ({ url: 'https://chat.deepseek.com/a/chat/s/example', title: 'Example', messages: [
  { role: 'user', text: 'original', attachments: [{ name: 'document', url: `https://files.deepseeksvc.com/file?signature=${signature}` }] },
] });
const receipt = { sessionId: 'imported-session', title: 'Example', warnings: [] };

test('a lost receipt retries the captured request despite changed page attachments', async () => {
  const operation = new ConversationImport(), calls = [];
  let reads = 0;
  const read = () => conversation(++reads);
  await assert.rejects(operation.run(read, async request => {
    calls.push(structuredClone(request));
    throw Error('lost receipt after commit');
  }), /lost receipt/);
  assert.equal(await operation.run(read, async request => { calls.push(structuredClone(request)); return receipt; }), receipt);
  assert.equal(reads, 1);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(operation.request, null);
  let next;
  await operation.run(read, async request => { next = request; return receipt; });
  assert.equal(reads, 2, 'a confirmed request permits a new page snapshot');
  assert.notEqual(next.requestId, calls[0].requestId);
});

test('re-entry shares extraction and submission, and a late receipt is retained for navigation retry', async () => {
  const operation = new ConversationImport(), entered = Promise.withResolvers(), released = Promise.withResolvers();
  const original = conversation('stable');
  let reads = 0, sends = 0;
  const first = operation.run(() => { reads++; return original; }, async () => { sends++; entered.resolve(); await released.promise; return receipt; });
  await entered.promise;
  assert.equal(operation.run(() => assert.fail('duplicate read'), () => assert.fail('duplicate send')), first);
  released.resolve(); await first;
  assert.equal(await operation.run(() => original, () => assert.fail('navigation retry must not resubmit')), receipt);
  assert.equal(reads, 1); assert.equal(sends, 1);
});

test('invalid receipts retain request identity; failed extraction never submits a partial snapshot', async () => {
  const operation = new ConversationImport();
  await assert.rejects(operation.run(() => { throw Error('closed page'); }, () => assert.fail('must not submit')), /closed page/);
  assert.equal(operation.request, null); assert.equal(operation.pending, null);
  await assert.rejects(operation.run(() => conversation('stable'), () => ({})), /迁移回执无效/);
  const id = operation.request.requestId;
  await operation.run(() => assert.fail('must not read again'), request => { assert.equal(request.requestId, id); return receipt; });
});
