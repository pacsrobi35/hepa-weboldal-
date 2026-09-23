import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Exercise the deployed handler shape without network, real database or email.
const source = (await readFile(new URL('../supabase/functions/submit-quote-request/index.ts', import.meta.url), 'utf8'))
  .replace(/^import .*\r?\n/, '');
const executable = stripTypeScriptTypes(source);
const token = '10000000-0000-4000-8000-000000000001';
const jpg = new Uint8Array([255, 216, 255, 1, 2, 3]);

function request({ message = 'Egyedi szekrény', files = ['rajz.jpg', 'foto.jpg'], bytes = jpg, submissionToken = token, callback = false } = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ customer_name: 'Teszt Ügyfél', phone: '+36701234567',
    email: 'test@example.test', project_type: 'konyhabútor', message, consent: 'true',
    wants_quote: callback ? 'false' : 'true', wants_callback: callback ? 'true' : 'false',
    submission_token: submissionToken })) form.set(name, value);
  for (const name of files) form.append('attachments', new File([bytes], name, { type: 'image/jpeg' }));
  return new Request('https://test.invalid', { method: 'POST', body: form, headers: {
    origin: 'https://hepabutor.hu', 'x-forwarded-for': '192.0.2.1',
  } });
}

function harness(options = {}) {
  const rows = new Map();
  const objects = new Map();
  let handler;
  let uploadAttempts = 0;
  let finalizations = 0;
  let lostFinalResponse = false;
  let notificationCalls = 0;
  const client = {
    async rpc(name, args) {
      if (name === 'consume_quote_submission_limit') return { data: true };
      if (name === 'begin_furniture_quote_submission') {
        const existing = rows.get(args.p_submission_token);
        if (existing) return { data: [{ quote_id: existing.id, state: existing.hash === null ? 'legacy'
          : existing.hash !== args.p_payload_hash ? 'conflict' : existing.state, duplicate: true }] };
        const row = { id: rows.size + 1, hash: args.p_payload_hash, expected: args.p_expected_files,
          state: 'ingesting', files: [], request: args.p_request };
        rows.set(args.p_submission_token, row);
        return { data: [{ quote_id: row.id, state: row.state, duplicate: false }] };
      }
      if (name === 'finalize_furniture_quote_submission') {
        const row = [...rows.values()].find(row => row.id === args.p_quote_id);
        assert.equal(row.hash, args.p_payload_hash);
        if (row.state !== 'ready') {
          assert.equal(args.p_files.length, row.expected);
          for (const file of args.p_files) assert.equal(objects.get(file.storage_path)?.size, file.size_bytes);
          row.files = args.p_files;
          row.state = 'ready';
          finalizations++;
        }
        if (options.loseFinalizeResponse && !lostFinalResponse) {
          lostFinalResponse = true;
          return { error: { code: 'NETWORK' } };
        }
        return { data: [{ quote_id: row.id, state: 'ready' }] };
      }
      if (name === 'claim_furniture_quote_notification') {
        const row = [...rows.values()].find(row => row.id === args.p_quote_id);
        assert.equal(row.state, 'ready');
        assert.equal(row.hash, args.p_payload_hash);
        if (row.notificationClaimed || !options.notifications) return { data: false };
        row.notificationClaimed = true;
        return options.loseClaimResponse ? { error: { code: 'NETWORK' } } : { data: true };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: { from(bucket) {
      assert.equal(bucket, 'quote-request-files');
      return {
        async upload(path, file, uploadOptions) {
          assert.equal(uploadOptions.upsert, false);
          uploadAttempts++;
          await options.beforeUpload?.(path, uploadAttempts);
          if (uploadAttempts === options.failUploadAttempt) return { error: { message: 'offline' } };
          if (objects.has(path)) return { error: { message: 'already exists' } };
          objects.set(path, file);
          return { data: { path } };
        },
        async download(path) {
          return objects.has(path) ? { data: objects.get(path) } : { error: { message: 'missing' } };
        },
      };
    } },
    from(table) {
      assert.equal(table, 'quote_requests');
      return { update() { return this; }, eq() { return this; }, async is() { return {}; } };
    },
  };
  const env = { SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-only', RESEND_API_KEY: 'test-only' };
  new Function('createClient', 'Deno', 'fetch', executable)(() => client, {
    env: { get: name => env[name] }, serve: callback => { handler = callback; },
  }, async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.match(options.headers['idempotency-key'], /^hepa-furniture-new-/);
    notificationCalls++;
    return Response.json({ id: 'test-message' });
  });
  return { rows, objects, send: value => handler(request(value)),
    get uploadAttempts() { return uploadAttempts; }, get finalizations() { return finalizations; },
    get notificationCalls() { return notificationCalls; } };
}

test('complete request and exact retry have one issue, two files and one finalization', async () => {
  const app = harness();
  assert.equal((await app.send()).status, 201);
  const retry = await app.send();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(app.rows.size, 1);
  assert.equal(app.objects.size, 2);
  assert.equal(app.uploadAttempts, 2);
  assert.equal(app.finalizations, 1);
});

test('second-file failure preserves staging; identical retry resumes without extra objects', async () => {
  const app = harness({ failUploadAttempt: 2 });
  const failed = await app.send();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'file-upload-incomplete');
  assert.equal(app.rows.get(token).state, 'ingesting');
  assert.equal(app.rows.get(token).files.length, 0);
  assert.equal(app.objects.size, 1);
  const retry = await app.send();
  assert.equal(retry.status, 200);
  assert.equal(app.rows.get(token).state, 'ready');
  assert.equal(app.rows.get(token).files.length, 2);
  assert.equal(app.objects.size, 2);
});

test('changed text and same-size changed file never acknowledge the older submission', async () => {
  const app = harness();
  await app.send();
  for (const changed of [{ message: 'Másik bútor' }, { bytes: new Uint8Array([255, 216, 255, 4, 5, 6]) }]) {
    const result = await app.send(changed);
    assert.equal(result.status, 409);
    const body = await result.json();
    assert.equal(body.code, 'submission-token-conflict');
    assert.equal(body.ok, false);
  }
  assert.equal(app.rows.size, 1);
  assert.equal(app.uploadAttempts, 2);
});

test('parallel retry can finish while original upload waits; both share one finalization', async () => {
  let announce;
  let release;
  const waiting = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = harness({ notifications: true, async beforeUpload(path, attempt) {
    if (attempt === 2) { announce(); await gate; }
  } });
  const first = app.send();
  await waiting;
  assert.equal(app.rows.get(token).state, 'ingesting');
  const second = await app.send();
  assert.equal(second.status, 200);
  release();
  assert.equal((await first).status, 201);
  assert.equal(app.rows.size, 1);
  assert.equal(app.objects.size, 2);
  assert.equal(app.finalizations, 1);
  assert.equal(app.rows.get(token).files.length, 2);
  assert.equal(app.notificationCalls, 1);
});

test('existing object with wrong bytes is never overwritten or accepted', async () => {
  const app = harness({ failUploadAttempt: 2 });
  await app.send();
  const path = [...app.objects.keys()][0];
  app.objects.set(path, new Blob([new Uint8Array([255, 216, 255, 9, 9, 9])]));
  const result = await app.send();
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'file-content-conflict');
  assert.equal(app.rows.get(token).state, 'ingesting');
  assert.equal(app.finalizations, 0);
});

test('lost finalization response is reconciled without another file metadata insert', async () => {
  const app = harness({ loseFinalizeResponse: true, notifications: true });
  const result = await app.send();
  assert.equal(result.status, 201);
  assert.equal((await result.json()).state, 'ready');
  assert.equal(app.finalizations, 1);
  assert.equal(app.notificationCalls, 1);
});

test('public duplicate cannot resend mail even after provider retention expires', async () => {
  const app = harness({ notifications: true });
  await app.send();
  // The durable claim, rather than a provider TTL or clock, prevents all retries.
  await app.send();
  await app.send();
  assert.equal(app.notificationCalls, 1);
});

test('lost mail claim response keeps the saved inquiry successful without uncertain resend', async () => {
  const app = harness({ notifications: true, loseClaimResponse: true });
  assert.equal((await app.send()).status, 201);
  assert.equal((await app.send()).status, 200);
  assert.equal(app.rows.get(token).state, 'ready');
  assert.equal(app.notificationCalls, 0);
});

test('callback without attachments completes normally; legacy retry is explicitly unconfirmed', async () => {
  const app = harness();
  assert.equal((await app.send({ files: [], callback: true })).status, 201);
  assert.equal(app.rows.get(token).expected, 0);
  assert.equal(app.rows.get(token).request.wants_callback, true);
  assert.equal(app.rows.get(token).request.wants_quote, false);
  assert.equal(app.uploadAttempts, 0);
  app.rows.get(token).hash = null;
  const legacy = await app.send({ files: [], callback: true });
  assert.equal(legacy.status, 409);
  assert.equal((await legacy.json()).code, 'legacy-submission-unconfirmed');
});

test('invalid token is rejected before any issue or attachment is created', async () => {
  const app = harness();
  const result = await app.send({ submissionToken: 'invalid' });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).code, 'invalid-submission-token');
  assert.equal(app.rows.size, 0);
  assert.equal(app.objects.size, 0);
});
