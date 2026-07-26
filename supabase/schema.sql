-- Run this in Supabase: SQL Editor → New query → Run

create extension if not exists "pgcrypto";

create table if not exists apartments (
  id text primary key,
  name text not null,
  neighborhood text default '',
  price bigint,
  rooms numeric,
  built numeric,
  garden text,
  url text,
  visited boolean default false,
  expired boolean default false,
  thumb text,
  source text default 'manual',
  chat_notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists verdicts (
  apartment_id text primary key references apartments(id) on delete cascade,
  relevant boolean not null default true,
  note text not null default '',
  updated_at timestamptz default now()
);

alter table apartments enable row level security;
alter table verdicts enable row level security;

-- Public read/write for this private couple-tracker (anon key in frontend).
-- Tighten later with auth if you want.
drop policy if exists "apartments_rw" on apartments;
create policy "apartments_rw" on apartments
  for all using (true) with check (true);

drop policy if exists "verdicts_rw" on verdicts;
create policy "verdicts_rw" on verdicts
  for all using (true) with check (true);

-- Realtime for live sync (ignore if already added)
do $$ begin
  alter publication supabase_realtime add table verdicts;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table apartments;
exception when duplicate_object then null; end $$;
