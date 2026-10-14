-- =============================================================================
-- Supabase Schema for Jeevan / VitaWatch & Voice Agent
-- Run this script in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query)
-- =============================================================================

-- 1. Device Live Stream (ESP32 -> Web Live Telemetry)
create table if not exists public.device_live_stream (
  device_id text primary key,
  sensor text not null default 'idle',
  data jsonb not null default '{}',
  signal_quality text default 'UNKNOWN',
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.device_live_stream enable row level security;

drop policy if exists "device_live_stream_select" on public.device_live_stream;
create policy "device_live_stream_select" on public.device_live_stream
  for select using (true);

drop policy if exists "device_live_stream_upsert" on public.device_live_stream;
create policy "device_live_stream_upsert" on public.device_live_stream
  for insert with check (true);

drop policy if exists "device_live_stream_update" on public.device_live_stream;
create policy "device_live_stream_update" on public.device_live_stream
  for update using (true);

-- 2. Device Commands (Web Dashboard -> ESP32 Sensor Selection Channel)
create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  command text not null default 'idle'
    check (command in ('idle', 'read_max30102', 'read_dht11', 'read_ad8232', 'read_all')),
  issued_by uuid references auth.users(id),
  issued_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.device_commands enable row level security;

drop policy if exists "device_commands_select" on public.device_commands;
create policy "device_commands_select" on public.device_commands
  for select using (true);

drop policy if exists "device_commands_insert" on public.device_commands;
create policy "device_commands_insert" on public.device_commands
  for insert with check (true);

drop policy if exists "device_commands_update" on public.device_commands;
create policy "device_commands_update" on public.device_commands
  for update using (true);

-- 3. Initial Default Records for JeevanCare ESP32
insert into public.device_commands (device_id, command)
  values ('esp32_jeevancare_01', 'idle')
  on conflict (device_id) do nothing;

insert into public.device_live_stream (device_id, sensor, data)
  values ('esp32_jeevancare_01', 'idle', '{}')
  on conflict (device_id) do nothing;

-- 4. Enable Supabase Realtime (optional but recommended for live streaming)
do $$
begin
  alter publication supabase_realtime add table public.device_live_stream;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.device_commands;
exception when duplicate_object then null;
end $$;

alter table public.device_live_stream replica identity full;
alter table public.device_commands replica identity full;

-- 5. VitaWatch Readings (Historical storage with AI analysis)
create table if not exists public.vitawatch_readings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  heart_rate integer not null check (heart_rate between 20 and 300),
  spo2 integer not null check (spo2 between 40 and 100),
  temperature numeric(5, 2) not null check (temperature between 25.0 and 45.0),
  ecg_bpm integer check (ecg_bpm is null or (ecg_bpm between 20 and 300)),
  ecg_status text not null default 'not_available' check (ecg_status in ('signal_detected', 'leads_off', 'not_available', 'noisy_signal')),
  systolic_bp integer check (systolic_bp is null or (systolic_bp between 40 and 300)),
  diastolic_bp integer check (diastolic_bp is null or (diastolic_bp between 20 and 200)),
  source text not null default 'manual' check (source in ('manual', 'esp32', 'demo')),
  device_id text,
  notes text,
  ai_analysis jsonb,
  recorded_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.vitawatch_readings enable row level security;

drop policy if exists "vitawatch_readings_select" on public.vitawatch_readings;
create policy "vitawatch_readings_select" on public.vitawatch_readings
  for select using (true);

drop policy if exists "vitawatch_readings_insert" on public.vitawatch_readings;
create policy "vitawatch_readings_insert" on public.vitawatch_readings
  for insert with check (true);
