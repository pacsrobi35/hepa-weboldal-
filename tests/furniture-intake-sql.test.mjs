import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Run against isolated PostgreSQL/WASM; never connects to a live project.
// Install @electric-sql/pglite@0.5.8 outside the repo and set PGLITE_MODULE to its dist/index.js.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const migration = await readFile(new URL('../supabase/migrations/20260923202331_reliable_furniture_quote_intake.sql', import.meta.url), 'utf8');

test('Postgres migration: atomic completion, replay protection, compatible defaults and RLS', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage;
      create table storage.objects (bucket_id text, name text, metadata jsonb);
      create table public.quote_requests (
        id bigint generated always as identity primary key, submission_token uuid unique,
        customer_name text, phone text, email text, project_type text, message text,
        approximate_dimensions text, wants_callback boolean, wants_quote boolean,
        wants_consultation boolean, consent boolean, source text default 'website',
        request_kind text default 'furniture', notification_sent_at timestamptz, notification_error text
      );
      create table public.quote_request_files (
        id bigint generated always as identity primary key,
        quote_request_id bigint references public.quote_requests(id), storage_path text unique,
        original_name text, content_type text, size_bytes bigint, content_sha256 text, file_purpose text
      );
      alter table public.quote_requests enable row level security;
      create policy staff_read on public.quote_requests for select to authenticated using (true);
      grant usage on schema public, storage to service_role, authenticated;
      grant all on all tables in schema public, storage to service_role;
      grant all on all sequences in schema public to service_role;
      grant select on public.quote_requests to authenticated;
      insert into public.quote_requests (customer_name, source, request_kind) values
        ('Existing furniture', 'website', 'furniture'), ('Existing cutting', 'website', 'cutting'),
        ('Existing manual', 'paper', 'furniture');
    `);
    await db.exec(migration);
    const existing = await db.query('select intake_state, intake_payload_hash from public.quote_requests order by id');
    assert.equal(existing.rows.length, 3);
    assert(existing.rows.every(row => row.intake_state === 'ready' && row.intake_payload_hash === null));

    const token = '10000000-0000-4000-8000-000000000001';
    const hash = 'a'.repeat(64);
    const body = { customer_name: 'Test', phone: '12345678', wants_callback: false, wants_quote: true, wants_consultation: false };
    const begin = (payloadHash = hash) => db.query('select * from public.begin_furniture_quote_submission($1,$2,$3,$4)', [token, payloadHash, 2, body]);
    await db.exec('set role service_role');
    const created = (await begin()).rows[0];
    assert.equal(created.state, 'ingesting');
    assert.equal(created.duplicate, false);
    const quoteId = created.quote_id;
    const duplicate = (await begin()).rows[0];
    assert.equal(duplicate.quote_id, quoteId);
    assert.equal(duplicate.state, 'ingesting');
    assert.equal((await begin('b'.repeat(64))).rows[0].state, 'conflict');

    await db.exec('reset role; set role authenticated');
    assert.equal((await db.query('select count(*)::int as n from public.quote_requests')).rows[0].n, 3);
    await assert.rejects(begin(), /permission denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(begin(), /permission denied/);
    await db.exec('reset role; set role service_role');

    const files = [1, 2].map(n => ({ storage_path: `furniture/${quoteId}/0${n}-${hash.slice(0, 24)}.jpg`,
      original_name: `${n}.jpg`, content_type: 'image/jpeg', size_bytes: 6, content_sha256: hash }));
    const finalize = (list = files) => db.query('select * from public.finalize_furniture_quote_submission($1,$2,$3)', [quoteId, hash, JSON.stringify(list)]);
    await assert.rejects(finalize(), /missing in storage/);
    await db.query('insert into storage.objects values ($1,$2,$3)', ['quote-request-files', files[0].storage_path, { size: 6 }]);
    await assert.rejects(finalize(), /missing in storage/);
    assert.equal((await db.query('select count(*)::int as n from public.quote_request_files')).rows[0].n, 0);
    assert.equal((await begin()).rows[0].state, 'ingesting');
    await assert.rejects(finalize([files[0]]), /incomplete/);
    await assert.rejects(finalize([files[0], files[0]]), /paths invalid/);
    await db.query('insert into storage.objects values ($1,$2,$3)', ['quote-request-files', files[1].storage_path, { size: 6 }]);
    assert.equal((await finalize()).rows[0].state, 'ready');
    assert.equal((await finalize()).rows[0].state, 'ready');
    assert.equal((await db.query('select count(*)::int as n from public.quote_request_files')).rows[0].n, 2);
    assert.equal((await begin()).rows[0].state, 'ready');

    const claim = () => db.query('select public.claim_furniture_quote_notification($1,$2) as claimed', [quoteId, hash]);
    assert.equal((await claim()).rows[0].claimed, true);
    assert.equal((await claim()).rows[0].claimed, false);
    await db.query("update public.quote_requests set notification_error='resend-timeout' where id=$1", [quoteId]);
    assert.equal((await claim()).rows[0].claimed, false);

    await db.exec('reset role; set role authenticated');
    assert.equal((await db.query('select count(*)::int as n from public.quote_requests')).rows[0].n, 4);
    await assert.rejects(claim(), /permission denied/);
  } finally {
    await db.close();
  }
});
