import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Actual PostgreSQL engine in an isolated WASM database; no live DDL or lead rows.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const migration = await readFile(new URL('../../migrations/20261001170439_add_consent_lead_funnel_events.sql', import.meta.url), 'utf8');
const session = '10000000-0000-4000-8000-000000000001';
const tokens = [1, 2, 3, 4, 5, 6].map(n => `20000000-0000-4000-8000-00000000000${n}`);

test('database collector verifies success, deduplicates, blocks public access and purges bounded expired rows', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.quote_requests (
        id bigint primary key, submission_token uuid unique, source text,
        intake_state text, request_kind text, wants_callback boolean
      );
      create table public.quote_workflows (quote_request_id bigint primary key, is_test boolean);
      create table public.cutting_quote_requests (quote_request_id bigint primary key, submission_state text);
      grant usage on schema public to service_role;
      grant select on public.quote_requests, public.quote_workflows, public.cutting_quote_requests to service_role;
    `);
    await db.exec(migration);
    for (let n = 0; n < tokens.length; n++) {
      await db.query('insert into public.quote_requests values ($1,$2,$3,$4,$5,$6)', [n + 1, tokens[n],
        n === 2 ? 'paper' : 'website', n === 3 ? 'ingesting' : 'ready', n >= 4 ? 'cutting' : 'furniture', n < 4]);
    }
    await db.exec("insert into public.quote_workflows values (2,true); insert into public.cutting_quote_requests values (5,'ingesting'), (6,'ready')");
    await db.exec('set role service_role');
    const record = async (event = 'form_start', funnel = 'callback', token = null) =>
      (await db.query('select public.record_lead_funnel_event($1,$2,$3,$4,$5,$6) as recorded',
        [session, event, funnel, funnel === 'callback' ? '/konyhabutor.html' : '/lapszabaszat-ajanlatkeres.html', 'mobile', token])).rows[0].recorded;
    assert.equal(await record(), true);
    assert.equal(await record(), false);
    assert.equal(await record('form_start', 'cutting'), true);
    for (const token of [tokens[1], tokens[2], tokens[3], tokens[4], tokens[5], session]) {
      assert.equal(await record('submit_success', 'callback', token), false);
    }
    assert.equal(await record('submit_success', 'callback', tokens[0]), true);
    assert.equal(await record('submit_success', 'callback', tokens[0]), false);
    assert.equal(await record('submit_success', 'cutting', tokens[4]), false);
    assert.equal(await record('submit_success', 'cutting', tokens[0]), false);
    assert.equal(await record('submit_success', 'cutting', tokens[5]), true);
    assert.equal((await db.query('select count(*)::int as n from private.lead_funnel_events')).rows[0].n, 4);
    assert.equal((await db.query('select count(*)::int as n from public.quote_requests')).rows[0].n, 6);
    await assert.rejects(record('form_start', 'callback', tokens[0]), /Invalid funnel event/);
    await assert.rejects(record('submit_success'), /Invalid funnel event/);
    await assert.rejects(record('unexpected_event'), /Invalid funnel event/);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(record(), /permission denied/);
      await assert.rejects(db.query('select * from private.lead_funnel_events'), /permission denied/);
    }
    await db.exec('reset role');
    await db.query('update public.quote_requests set wants_callback=false where id=1');
    await db.exec('set role service_role');
    assert.equal((await db.query('select public.record_lead_funnel_event($1,$2,$3,$4,$5,$6) as recorded',
      ['10000000-0000-4000-8000-000000000002', 'submit_success', 'callback', '/konyhabutor.html', 'mobile', tokens[0]])).rows[0].recorded, false);
    await db.exec('reset role');
    const protection = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='private.lead_funnel_events'::regclass")).rows[0];
    assert.deepEqual(protection, { relrowsecurity: true, relforcerowsecurity: true });
    assert.equal((await db.query("select prosecdef from pg_proc where proname='record_lead_funnel_event'")).rows[0].prosecdef, false);
    assert.deepEqual((await db.query("select column_name from information_schema.columns where table_schema='private' and table_name='lead_funnel_events' order by ordinal_position")).rows.map(r => r.column_name),
      ['session_token', 'event', 'funnel', 'page', 'device', 'created_at', 'is_test']);
    await db.exec(`
      insert into private.lead_funnel_events (session_token,event,funnel,page,device,created_at)
      select ('30000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'cta_click', 'callback', '/', 'desktop', now()-interval '31 days'
      from generate_series(1,1005) n;
      set role service_role;
    `);
    await record('form_view');
    assert.equal((await db.query("select count(*)::int as n from private.lead_funnel_events where created_at < now()-interval '30 days'")).rows[0].n, 5);
    await record('submit_attempt');
    assert.equal((await db.query("select count(*)::int as n from private.lead_funnel_events where created_at < now()-interval '30 days'")).rows[0].n, 0);

    await db.exec(`
      insert into private.lead_funnel_events (session_token,event,funnel,page,device)
      select ('40000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'cta_click', 'callback', '/', 'desktop'
      from generate_series(1,10000) n;
    `);
    const beforeLimit = (await db.query('select count(*)::int as n from private.lead_funnel_events')).rows[0].n;
    assert.equal(await record('cta_click'), false);
    assert.equal((await db.query('select count(*)::int as n from private.lead_funnel_events')).rows[0].n, beforeLimit);
  } finally { await db.close(); }
});
