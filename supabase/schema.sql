-- Run this once in the Supabase SQL editor. Safe to run again after an update.
create extension if not exists pgcrypto;

create table if not exists public.tracked_emails (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique,
  owner uuid not null default '00000000-0000-0000-0000-000000000001',
  subject text not null default '',
  to_recipients text[] not null default '{}',
  cc_recipients text[] not null default '{}',
  bcc_recipients text[] not null default '{}',
  links jsonb not null default '[]',
  remind_at timestamptz,
  reminded_at timestamptz,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.tracked_emails add column if not exists owner uuid not null default '00000000-0000-0000-0000-000000000001';
alter table public.tracked_emails add column if not exists links jsonb not null default '[]';
alter table public.tracked_emails add column if not exists remind_at timestamptz;
alter table public.tracked_emails add column if not exists reminded_at timestamptz;
create index if not exists tracked_emails_owner_idx on public.tracked_emails (owner, sent_at desc);
create index if not exists tracked_emails_remind_idx on public.tracked_emails (owner, remind_at) where reminded_at is null and remind_at is not null;

create table if not exists public.email_events (
  id bigint generated always as identity primary key,
  token uuid not null,
  owner uuid not null default '00000000-0000-0000-0000-000000000001',
  type text not null default 'open',          -- 'open' or 'click'
  link_n int,
  source text not null default 'direct',      -- direct, google_proxy, yahoo_proxy, apple_privacy
  mine boolean not null default false,        -- the owner said "that was me"
  occurred_at timestamptz not null default now(),
  user_agent text not null default '',
  ip_hash text not null default ''
);
alter table public.email_events add column if not exists owner uuid not null default '00000000-0000-0000-0000-000000000001';
alter table public.email_events add column if not exists type text not null default 'open';
alter table public.email_events add column if not exists link_n int;
alter table public.email_events add column if not exists source text not null default 'direct';
alter table public.email_events add column if not exists mine boolean not null default false;
create index if not exists email_events_token_idx on public.email_events (token, occurred_at);
create index if not exists email_events_owner_idx on public.email_events (owner, id);

-- Moments when the extension saw the sender looking at their own email in Gmail.
create table if not exists public.sender_views (
  id bigint generated always as identity primary key,
  token uuid not null,
  owner uuid not null default '00000000-0000-0000-0000-000000000001',
  seen_at timestamptz not null default now()
);
alter table public.sender_views add column if not exists owner uuid not null default '00000000-0000-0000-0000-000000000001';
create index if not exists sender_views_token_idx on public.sender_views (token, seen_at);

-- Times when someone paused counting (for example while checking their phone).
create table if not exists public.pause_windows (
  id bigint generated always as identity primary key,
  owner uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null
);
create index if not exists pause_windows_owner_idx on public.pause_windows (owner, ends_at);

-- Only the backend (service role key) may touch these tables. The apps never talk to them directly.
alter table public.tracked_emails enable row level security;
alter table public.email_events enable row level security;
alter table public.sender_views enable row level security;
alter table public.pause_windows enable row level security;
revoke all on public.tracked_emails, public.email_events, public.sender_views, public.pause_windows from anon, authenticated;
