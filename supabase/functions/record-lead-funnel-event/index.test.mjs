import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = (await readFile(new URL('./index.ts', import.meta.url), 'utf8')).replace(/^import .*\r?\n/, '');
const executable = stripTypeScriptTypes(source);
const publicKey = 'sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl';
const token = '10000000-0000-4000-8000-000000000001';
const base = { sessionToken: token, event: 'form_start', funnel: 'callback', page: '/konyhabutor.html', device: 'mobile' };

function harness(options = {}) {
  const calls = [];
  let handler;
  const env = { SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-secret', ...options.env };
  new Function('createClient', 'Deno', executable)((url, key, config) => {
    assert.equal(url, env.SUPABASE_URL);
    assert.equal(key, 'server-only-test-secret');
    assert.deepEqual(config, { auth: { persistSession: false, autoRefreshToken: false } });
    return { async rpc(name, args) {
      calls.push({ name, args });
      if (options.throwRpc) throw new Error('must-not-leak');
      return options.rpcResult || { data: true, error: null };
    } };
  }, { env: { get: key => env[key] }, serve: value => { handler = value; } });
  return { calls, async send(body = base, init = {}) {
    return handler(new Request('https://collector.invalid', {
      method: 'POST', body: JSON.stringify(body), ...init,
      headers: { origin: 'https://hepabutor.hu', 'content-type': 'application/json', apikey: publicKey, ...init.headers },
    }));
  }, handler };
}

test('collector accepts only production origins and a recognised public API key', async () => {
  const app = harness();
  for (const origin of ['', 'null', 'https://attacker.invalid', 'http://localhost:3000', 'https://hepa-weboldal.vercel.app']) {
    assert.equal((await app.send(base, { headers: { origin } })).status, 403);
  }
  for (const apikey of ['', 'arbitrary-key', 'server-only-test-secret']) {
    assert.equal((await app.send(base, { headers: { apikey } })).status, 401);
  }
  assert.equal(app.calls.length, 0);
  const preflight = await app.handler(new Request('https://collector.invalid', { method: 'OPTIONS', headers: { origin: 'https://hepabutor.hu' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type, apikey');
  assert.equal(await preflight.text(), '');
  assert.equal((await app.send(base, { headers: { origin: 'https://www.hepabutor.hu' } })).status, 202);
});

test('rejects unknown keys, arbitrary strings and any submitted customer contents', async () => {
  const app = harness();
  for (const body of [null, [], 'string', {}, { ...base, email: 'customer@example.com' },
    { ...base, gclid: 'click-id' }, { ...base, message: 'Kitchen dimensions' },
    { ...base, page: '/konyhabutor.html?phone=123' }, { ...base, event: 'custom_event' },
    { ...base, funnel: 'other' }, { ...base, device: 'tablet' },
    { ...base, sessionToken: '10000000-0000-1000-8000-000000000001' },
    { ...base, submissionToken: token }, { ...base, event: 'submit_success' },
    { ...base, event: 'submit_success', submissionToken: 'not-a-token' }]) {
    assert.equal((await app.send(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(app.calls.length, 0);
});

test('both funnels send only whitelisted fields to the service-role-only RPC', async () => {
  const app = harness();
  for (const funnel of ['callback', 'cutting']) {
    for (const event of ['cta_click', 'form_view', 'form_start', 'submit_attempt', 'submit_success']) {
      const body = { ...base, funnel, event, ...(event === 'submit_success' ? { submissionToken: token } : {}) };
      const result = await app.send(body, { headers: { authorization: 'Bearer untrusted-user-jwt' } });
      assert.equal(result.status, 202);
      assert.deepEqual(await result.json(), { ok: true });
      assert.deepEqual(app.calls.at(-1), { name: 'record_lead_funnel_event', args: {
        p_session_token: token, p_event: event, p_funnel: funnel,
        p_page: base.page, p_device: 'mobile', p_submission_token: body.submissionToken || null,
      } });
    }
  }
});

test('checks size even without trustworthy Content-Length and requires JSON', async () => {
  const app = harness();
  assert.equal((await app.send(base, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await app.send(base, { headers: { 'content-length': '1000000' } })).status, 413);
  assert.equal((await app.send(base, { headers: { 'content-length': '-1' } })).status, 413);
  assert.equal((await app.send(base, { body: 'not-json' })).status, 400);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(900));
    controller.enqueue(new Uint8Array(900));
    controller.close();
  } });
  assert.equal((await app.send(base, { body: stream, duplex: 'half', headers: { 'content-length': '0' } })).status, 413);
  assert.equal(app.calls.length, 0);
});

test('RPC failure is isolated and customer token existence is never disclosed', async () => {
  for (const options of [{ rpcResult: { error: { message: 'sensitive internal error' } } }, { throwRpc: true },
    { env: { SUPABASE_SERVICE_ROLE_KEY: undefined } }]) {
    const result = await harness(options).send();
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { ok: false });
  }
  for (const data of [true, false]) {
    const result = await harness({ rpcResult: { data, error: null } }).send({ ...base, event: 'submit_success', submissionToken: token });
    assert.equal(result.status, 202);
    assert.deepEqual(await result.json(), { ok: true });
  }
});
