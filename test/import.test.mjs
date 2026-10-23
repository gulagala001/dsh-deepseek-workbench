import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '@deepseek-ai/dsh-session';
import { ConversationImporter } from '../src/import.mjs';

const input = () => ({ requestId: 'synthetic-request', conversation: {
  url: 'https://chat.deepseek.com/a/chat/s/example', title: 'Synthetic import', warnings: [], messages: [
    { role: 'user', text: 'original\ntext', attachments: [{ name: 'document.txt', data: Buffer.from('exact bytes').toString('base64') }] },
    { role: 'assistant', text: 'answer' }, { role: 'user', text: 'unanswered' },
  ],
} });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dswb-import-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const live = new Map(), stored = new Map(), calls = { creates: 0, files: 0, flushes: 0, workspace: 0 };
  const services = {
    sessionPersistence: {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'continuation' }) },
    attachments: { async saveFile({ data, name }) { calls.files++; return { id: 'f'.repeat(64), size: data.length, name }; } },
    sessionController: { async rename({ sessionId, title }) {
      let session = live.get(sessionId);
      if (!session) { const saved = stored.get(sessionId); session = Session.create(sessionId, saved.events, saved.header); live.set(sessionId, session); }
      session.append('plugin/record', { plugin: 'test-import-title', value: title });
    } },
    sessionQuery: { async readSession(id) {
      const saved = stored.get(id);
      if (!saved) throw Object.assign(Error('missing session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      return saved;
    } },
    workspaceRegistry: { async create() { return { async attachSession() { calls.workspace++; } }; } },
  };
  const ctx = {
    get: name => services[name],
    llm: { resolveCallConfig: async route => route },
    sessions: { get: id => live.get(id), async flush(session) {
      calls.flushes++;
      stored.set(session.id, { header: session.header, events: session.snapshotEvents() });
      return true;
    } },
    agents: { async create({ sessionId, seed, meta }) {
      calls.creates++;
      const session = Session.create(sessionId, seed, { ...Session.create(sessionId).header, ...meta });
      live.set(sessionId, session);
      return { agent: { session } };
    } },
  };
  const importer = new ConversationImporter({ ctx, directory });
  const record = async () => JSON.parse(await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))), 'utf8'));
  return { directory, ctx, services, calls, importer, live, stored, record };
}

test('missing persistence fails before creating an unsavable session or writing attachments', async t => {
  const f = await fixture(t), request = input();
  delete f.services.sessionPersistence;
  await assert.rejects(f.importer.import(request), /会话持久化不可用/);
  assert.equal(f.calls.creates, 0); assert.equal(f.calls.files, 0);
  f.services.sessionPersistence = {};
  await f.importer.import(request);
  assert.equal(f.calls.creates, 1); assert.equal((await f.record()).complete, true);
});

test('captured bytes require storage; genuinely unavailable source files remain explicit references', async t => {
  const f = await fixture(t), request = input(), store = f.services.attachments;
  delete f.services.attachments;
  await assert.rejects(f.importer.import(request), /附件存储不可用/);
  assert.equal(f.calls.creates, 0);
  f.services.attachments = store;
  const result = await f.importer.import(request), session = f.live.get(result.sessionId);
  const messages = session.deriveMessages();
  assert.equal(messages.find(row => row.role === 'user').content[0].text, 'original\ntext');
  assert.equal(messages.find(row => row.role === 'user').content[1].type, 'file');
  assert.equal(session.snapshotEvents().findLast(row => row.type === 'turn/end').data.reason.kind, 'interrupted');
  const warnings = [];
  delete f.services.attachments;
  const references = await f.importer.materializeAttachments([{ text: '', attachments: [{ name: 'missing.txt', url: 'https://files.deepseeksvc.com/missing' }] }], warnings);
  assert.match(references[0][0].text, /missing\.txt/); assert.equal(warnings.length, 1);
});

test('attachment failure leaves no background writes and retries preserve message order', async t => {
  const f = await fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers();
  const writes = [];
  let active = 0, peak = 0, fail = true;
  f.services.attachments.saveFile = async ({ name }) => {
    active++; peak = Math.max(peak, active); writes.push(name);
    try {
      if (name === '0') { started.resolve(); await release.promise; }
      if (name === '1' && fail) throw Error('disk full');
      return { name };
    } finally { active--; }
  };
  const messages = Array.from({ length: 120 }, (_, index) => ({ text: `row ${index}`, attachments: [{ name: String(index), data: 'eA==' }] }));
  const rejected = assert.rejects(f.importer.materializeAttachments(messages, []), /disk full/);
  await started.promise;
  const atFirstWrite = [...writes];
  release.resolve(); await rejected;
  assert.ok(atFirstWrite.length <= 16 && atFirstWrite.includes('1'));
  assert.deepEqual(writes, atFirstWrite, 'failed requests must not start queued writes');
  assert.equal(active, 0); assert.ok(peak <= 16);
  fail = false; writes.length = 0;
  const result = await f.importer.materializeAttachments(messages, []);
  assert.deepEqual(writes, messages.map(row => row.attachments[0].name));
  assert.deepEqual(result.map(row => row[1].attachment.name), writes);
});

test('persistence failure retries the same session and native cold replay preserves all imported messages', async t => {
  const f = await fixture(t), request = input(), flush = f.ctx.sessions.flush;
  f.ctx.sessions.flush = async () => { throw Error('flush failed'); };
  await assert.rejects(f.importer.import(request), /flush failed/);
  assert.equal((await f.record()).complete, false);
  f.ctx.sessions.flush = flush;
  const result = await f.importer.import(request);
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.files, 1);
  const saved = f.stored.get(result.sessionId);
  const replay = Session.create(result.sessionId, saved.events, saved.header);
  assert.deepEqual(replay.deriveMessages().filter(row => row.role !== 'system').map(row => row.content[0].text), ['original\ntext', 'answer', 'unanswered']);
  f.live.clear();
  const cold = new ConversationImporter({ ctx: f.ctx, directory: f.directory });
  assert.deepEqual(await cold.import(request), result);
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.files, 1);
  await assert.rejects(cold.import({ ...request, conversation: { ...request.conversation, title: 'changed' } }), /内容已改变/);
});

test('concurrent attachment failures are all reported and fallback warnings follow message order', async t => {
  const f = await fixture(t), first = Error('first write failed'), second = Error('second write failed'), writes = [];
  f.services.attachments.saveFile = async ({ name }) => {
    writes.push(name);
    if (name === '0') { await new Promise(setImmediate); throw first; }
    if (name === '2') throw second;
    return { name };
  };
  const rows = Array.from({ length: 32 }, (_, index) => ({ text: '', attachments: [{ name: String(index), data: 'eA==' }, { name: `missing-${index}` }] }));
  await assert.rejects(f.importer.materializeAttachments(rows, []), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [first, second]); return true;
  });
  assert.ok(writes.length < rows.length, 'an observed failure stops the remaining queue');
  f.services.attachments.saveFile = async ({ name }) => { if (name === '0') await new Promise(setImmediate); return { name }; };
  const warnings = [];
  await f.importer.materializeAttachments(rows, warnings);
  assert.deepEqual(warnings.map(value => /missing-\d+/.exec(value)[0]), rows.map((_, index) => `missing-${index}`));
});

test('same-request concurrency shares work; failure after durable write resumes workspace publication', async t => {
  const f = await fixture(t), request = { ...input(), cwd: join(f.directory, 'workspace') };
  f.services.workspaceRegistry.create = async () => { throw Error('workspace unavailable'); };
  const first = f.importer.import(request), second = f.importer.import(structuredClone(request));
  assert.equal(first, second);
  await assert.rejects(first, /workspace unavailable/);
  assert.equal((await f.record()).complete, false);
  f.live.clear();
  f.services.workspaceRegistry.create = async () => ({ attachSession: async () => { f.calls.workspace++; } });
  await new ConversationImporter({ ctx: f.ctx, directory: f.directory }).import(request);
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.files, 1); assert.equal(f.calls.workspace, 1);
  assert.equal((await f.record()).complete, true);
});
