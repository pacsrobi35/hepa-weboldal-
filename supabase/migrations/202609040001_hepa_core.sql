begin;

create extension if not exists pgcrypto;

create sequence if not exists public.hepa_job_number_seq
    start with 1001
    increment by 1;

create table if not exists public.customers (
    id uuid primary key default gen_random_uuid(),
    customer_type text not null default 'individual'
        check (customer_type in ('individual', 'company')),
    name text not null check (char_length(trim(name)) between 2 and 120),
    phone text,
    email text,
    company_name text,
    tax_number text,
    billing_address jsonb not null default '{}'::jsonb,
    delivery_address jsonb not null default '{}'::jsonb,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
    id uuid primary key default gen_random_uuid(),
    job_number text not null unique default (
        'HEPA-' || to_char(current_date, 'YYYY') || '-' ||
        lpad(nextval('public.hepa_job_number_seq')::text, 5, '0')
    ),
    customer_id uuid not null references public.customers(id) on delete restrict,
    kind text not null
        check (kind in ('furniture_quote', 'cutting_order')),
    source text not null
        check (source in ('website_quote', 'online_cutting', 'workshop_manual')),
    status text not null default 'new'
        check (status in (
            'new',
            'estimating',
            'quote_sent',
            'accepted',
            'deposit_pending',
            'deposit_paid',
            'cutting',
            'edgebanding',
            'ready',
            'invoicing',
            'payment_pending',
            'closed',
            'cancelled'
        )),
    title text not null,
    description text,
    approximate_dimensions text,
    service_requests text[] not null default '{}'::text[],
    source_metadata jsonb not null default '{}'::jsonb,
    submission_token uuid unique,
    priority smallint not null default 0 check (priority between 0 and 3),
    currency char(3) not null default 'HUF',
    quoted_net numeric(14, 2) check (quoted_net is null or quoted_net >= 0),
    quoted_gross numeric(14, 2) check (quoted_gross is null or quoted_gross >= 0),
    final_net numeric(14, 2) check (final_net is null or final_net >= 0),
    final_gross numeric(14, 2) check (final_gross is null or final_gross >= 0),
    due_date date,
    assigned_to uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    closed_at timestamptz
);

create index if not exists jobs_customer_id_idx on public.jobs(customer_id);
create index if not exists jobs_status_created_at_idx on public.jobs(status, created_at desc);
create index if not exists jobs_kind_status_idx on public.jobs(kind, status);

create table if not exists public.job_status_history (
    id bigint generated always as identity primary key,
    job_id uuid not null references public.jobs(id) on delete cascade,
    from_status text,
    to_status text not null,
    note text,
    changed_by uuid,
    created_at timestamptz not null default now()
);

create index if not exists job_status_history_job_id_idx
    on public.job_status_history(job_id, created_at desc);

create table if not exists public.materials (
    id uuid primary key default gen_random_uuid(),
    supplier text,
    manufacturer text not null,
    product_group text,
    decor_code text not null,
    decor_name text not null,
    thickness_mm numeric(6, 2) not null check (thickness_mm > 0),
    sheet_width_mm integer check (sheet_width_mm is null or sheet_width_mm > 0),
    sheet_height_mm integer check (sheet_height_mm is null or sheet_height_mm > 0),
    purchase_price numeric(14, 2) check (purchase_price is null or purchase_price >= 0),
    sale_price numeric(14, 2) check (sale_price is null or sale_price >= 0),
    vat_rate numeric(5, 2) not null default 27 check (vat_rate between 0 and 100),
    currency char(3) not null default 'HUF',
    active boolean not null default true,
    price_updated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists materials_lookup_idx
    on public.materials(manufacturer, decor_code, thickness_mm)
    where active = true;

create table if not exists public.cut_items (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.jobs(id) on delete cascade,
    line_number integer not null check (line_number > 0),
    material_id uuid references public.materials(id) on delete restrict,
    description text,
    length_mm integer not null check (length_mm > 0),
    width_mm integer not null check (width_mm > 0),
    quantity integer not null default 1 check (quantity > 0),
    grain_direction text not null default 'none'
        check (grain_direction in ('none', 'length', 'width')),
    edge_top text,
    edge_right text,
    edge_bottom text,
    edge_left text,
    machining_notes text,
    unit_price numeric(14, 2) check (unit_price is null or unit_price >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_id, line_number)
);

create index if not exists cut_items_job_id_idx on public.cut_items(job_id);
create index if not exists cut_items_material_id_idx on public.cut_items(material_id);

create table if not exists public.attachments (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.jobs(id) on delete cascade,
    category text not null default 'customer_upload'
        check (category in ('customer_upload', 'design', 'quote', 'invoice', 'other')),
    storage_bucket text not null default 'hepa-private',
    storage_path text not null unique,
    original_name text not null,
    mime_type text not null,
    size_bytes bigint not null check (size_bytes > 0),
    uploaded_by uuid,
    created_at timestamptz not null default now()
);

create index if not exists attachments_job_id_idx on public.attachments(job_id);

create table if not exists public.invoices (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.jobs(id) on delete restrict,
    invoice_number text unique,
    invoice_type text not null
        check (invoice_type in ('proforma', 'deposit', 'final', 'correction')),
    status text not null default 'draft'
        check (status in ('draft', 'issued', 'paid', 'overdue', 'cancelled')),
    net_amount numeric(14, 2) not null check (net_amount >= 0),
    vat_amount numeric(14, 2) not null check (vat_amount >= 0),
    gross_amount numeric(14, 2) not null check (gross_amount >= 0),
    issued_at timestamptz,
    due_date date,
    paid_at timestamptz,
    pdf_storage_path text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists invoices_job_id_idx on public.invoices(job_id);
create index if not exists invoices_status_due_date_idx on public.invoices(status, due_date);

create table if not exists public.payments (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.jobs(id) on delete restrict,
    invoice_id uuid references public.invoices(id) on delete set null,
    payment_type text not null
        check (payment_type in ('deposit', 'balance', 'refund', 'other')),
    status text not null default 'pending'
        check (status in ('pending', 'paid', 'failed', 'refunded')),
    amount numeric(14, 2) not null check (amount > 0),
    currency char(3) not null default 'HUF',
    method text check (method is null or method in ('bank_transfer', 'cash', 'card', 'other')),
    due_date date,
    paid_at timestamptz,
    reference text,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists payments_job_id_idx on public.payments(job_id);
create index if not exists payments_invoice_id_idx on public.payments(invoice_id);
create index if not exists payments_status_due_date_idx on public.payments(status, due_date);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

drop trigger if exists materials_set_updated_at on public.materials;
create trigger materials_set_updated_at
before update on public.materials
for each row execute function public.set_updated_at();

drop trigger if exists cut_items_set_updated_at on public.cut_items;
create trigger cut_items_set_updated_at
before update on public.cut_items
for each row execute function public.set_updated_at();

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
before update on public.invoices
for each row execute function public.set_updated_at();

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
before update on public.payments
for each row execute function public.set_updated_at();

create or replace function public.record_job_status_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        insert into public.job_status_history (job_id, from_status, to_status)
        values (new.id, null, new.status);
    elsif old.status is distinct from new.status then
        insert into public.job_status_history (job_id, from_status, to_status)
        values (new.id, old.status, new.status);
    end if;

    return new;
end;
$$;

drop trigger if exists jobs_record_status on public.jobs;
create trigger jobs_record_status
after insert or update of status on public.jobs
for each row execute function public.record_job_status_change();

create or replace function public.create_quote_request(
    p_submission_token uuid,
    p_name text,
    p_phone text,
    p_email text default null,
    p_furniture_type text default null,
    p_description text default null,
    p_approx_dimensions text default null,
    p_service_requests text[] default '{}'::text[],
    p_source_metadata jsonb default '{}'::jsonb
)
returns table (job_id uuid, job_number text)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_customer_id uuid;
    v_existing public.jobs%rowtype;
begin
    if p_submission_token is null then
        raise exception 'submission_token is required';
    end if;

    select * into v_existing
    from public.jobs
    where submission_token = p_submission_token;

    if found then
        return query select v_existing.id, v_existing.job_number;
        return;
    end if;

    if char_length(trim(coalesce(p_name, ''))) < 2 then
        raise exception 'name is required';
    end if;

    if char_length(trim(coalesce(p_phone, ''))) < 6 then
        raise exception 'phone is required';
    end if;

    if not coalesce(p_service_requests, '{}'::text[])
        <@ array['callback', 'quote', 'consultation']::text[] then
        raise exception 'invalid service request';
    end if;

    insert into public.customers (name, phone, email)
    values (
        trim(p_name),
        trim(p_phone),
        nullif(lower(trim(coalesce(p_email, ''))), '')
    )
    returning id into v_customer_id;

    return query
    insert into public.jobs (
        customer_id,
        kind,
        source,
        status,
        title,
        description,
        approximate_dimensions,
        service_requests,
        source_metadata,
        submission_token
    )
    values (
        v_customer_id,
        'furniture_quote',
        'website_quote',
        'new',
        coalesce(nullif(trim(coalesce(p_furniture_type, '')), ''), 'Egyedi bútor árajánlat'),
        nullif(trim(coalesce(p_description, '')), ''),
        nullif(trim(coalesce(p_approx_dimensions, '')), ''),
        coalesce(p_service_requests, '{}'::text[]),
        coalesce(p_source_metadata, '{}'::jsonb),
        p_submission_token
    )
    returning id, jobs.job_number;
end;
$$;

create or replace view public.job_financial_summary
with (security_invoker = true)
as
select
    j.id as job_id,
    j.job_number,
    coalesce(i.invoiced_total, 0)::numeric(14, 2) as invoiced_total,
    coalesce(p.paid_total, 0)::numeric(14, 2) as paid_total,
    greatest(coalesce(i.invoiced_total, 0) - coalesce(p.paid_total, 0), 0)::numeric(14, 2) as outstanding,
    coalesce(p.deposit_paid, 0)::numeric(14, 2) as deposit_paid
from public.jobs j
left join (
    select job_id, sum(gross_amount) filter (where status <> 'cancelled') as invoiced_total
    from public.invoices
    group by job_id
) i on i.job_id = j.id
left join (
    select
        job_id,
        sum(case when payment_type = 'refund' then -amount else amount end)
            filter (where status = 'paid') as paid_total,
        sum(amount) filter (where status = 'paid' and payment_type = 'deposit') as deposit_paid
    from public.payments
    group by job_id
) p on p.job_id = j.id;

alter table public.customers enable row level security;
alter table public.jobs enable row level security;
alter table public.job_status_history enable row level security;
alter table public.materials enable row level security;
alter table public.cut_items enable row level security;
alter table public.attachments enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;

revoke all on table public.customers from anon, authenticated;
revoke all on table public.jobs from anon, authenticated;
revoke all on table public.job_status_history from anon, authenticated;
revoke all on table public.materials from anon, authenticated;
revoke all on table public.cut_items from anon, authenticated;
revoke all on table public.attachments from anon, authenticated;
revoke all on table public.invoices from anon, authenticated;
revoke all on table public.payments from anon, authenticated;
revoke all on table public.job_financial_summary from anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.record_job_status_change() from public, anon, authenticated;
revoke execute on function public.create_quote_request(
    uuid, text, text, text, text, text, text, text[], jsonb
) from public, anon, authenticated;

grant select, insert, update on table public.customers to service_role;
grant select, insert, update on table public.jobs to service_role;
grant select, insert on table public.job_status_history to service_role;
grant select, insert, update on table public.materials to service_role;
grant select, insert, update, delete on table public.cut_items to service_role;
grant select, insert, update, delete on table public.attachments to service_role;
grant select, insert, update on table public.invoices to service_role;
grant select, insert, update on table public.payments to service_role;
grant select on table public.job_financial_summary to service_role;
grant usage, select on sequence public.hepa_job_number_seq to service_role;
grant usage, select on sequence public.job_status_history_id_seq to service_role;
grant execute on function public.create_quote_request(
    uuid, text, text, text, text, text, text, text[], jsonb
) to service_role;

alter default privileges for role postgres in schema public
    revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
    revoke usage, select on sequences from anon, authenticated, service_role;

commit;
