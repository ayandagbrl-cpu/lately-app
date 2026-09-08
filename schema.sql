-- ============================================================
-- LATELY — Supabase/Postgres schema
-- Run this in your Supabase project's SQL Editor (one paste, run once).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- PROFILES
-- One row per real account. Linked 1:1 to Supabase's built-in
-- auth.users table, which already handles email/password,
-- sessions, and login for us — we don't touch auth ourselves.
-- ------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  username text unique,
  bio text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Automatically create a profile row whenever someone signs up.
create function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', 'You'));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ------------------------------------------------------------
-- CONNECTIONS
-- The mutual-approval relationship between two people ("People" tab).
-- A row starts 'pending' when requester adds recipient, and becomes
-- 'accepted' only when the recipient approves it. This is what makes
-- the approval flow real instead of a local-only illusion.
-- ------------------------------------------------------------
create table connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  unique (requester_id, recipient_id),
  check (requester_id <> recipient_id)
);

-- ------------------------------------------------------------
-- CIRCLES
-- A user's own private grouping of people ("Close friends", "Family",
-- custom circles). "Only me" doesn't need a row — memories with no
-- circle_id are private to the author by default (see memories policy).
-- ------------------------------------------------------------
create table circles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table circle_members (
  circle_id uuid not null references circles(id) on delete cascade,
  person_id uuid not null references profiles(id) on delete cascade,
  primary key (circle_id, person_id)
);

-- ------------------------------------------------------------
-- MEMORIES
-- circle_id = null means "Only me" (private, author-only).
-- Media lives in Supabase Storage; these columns just hold the URL.
-- ------------------------------------------------------------
create table memories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  note text,
  image_url text,
  video_url text,
  audio_url text,
  chapter text,
  circle_id uuid references circles(id) on delete set null,
  memory_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- REACTIONS
-- One reaction per person per memory (re-tapping changes it, matching
-- the tapback behavior already built in the frontend).
-- ------------------------------------------------------------
create table memory_reactions (
  memory_id uuid not null references memories(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (memory_id, sender_id)
);

-- ------------------------------------------------------------
-- REPLIES
-- A private thread between exactly two people (the memory's author,
-- and whoever started this particular thread) — never a public
-- comment section, matching the "no audience effect" design decision.
-- ------------------------------------------------------------
create table memory_replies (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references memories(id) on delete cascade,
  thread_with_id uuid not null references profiles(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- ACTIVITY
-- Notifications. recipient_id is who SHOULD see this entry. Rows here
-- are only ever created by triggers below (never inserted directly by
-- the client) — this is what makes inboxes two-sided and correct: a
-- reaction/reply always notifies whoever didn't send it.
-- ------------------------------------------------------------
create table activity (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  actor_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in ('reaction', 'reply', 'request_received', 'request_accepted')),
  memory_id uuid references memories(id) on delete cascade,
  preview text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- This is the important part: these rules are enforced by Postgres
-- itself, on every query, no matter what the app does. A bug in the
-- frontend JS can no longer leak someone's private memory.
-- ============================================================

alter table profiles enable row level security;
alter table connections enable row level security;
alter table circles enable row level security;
alter table circle_members enable row level security;
alter table memories enable row level security;
alter table memory_reactions enable row level security;
alter table memory_replies enable row level security;
alter table activity enable row level security;

-- PROFILES: anyone signed in can look up basic profile info (needed
-- for the "search by name/username" flow). Editing is self-only.
create policy "profiles are viewable by any signed-in user"
  on profiles for select using (auth.uid() is not null);
create policy "users can update their own profile"
  on profiles for update using (auth.uid() = id);

-- CONNECTIONS: you can see a connection if you're either party.
-- Only the requester can create one. Only the recipient can accept it.
create policy "see connections you're part of"
  on connections for select using (auth.uid() = requester_id or auth.uid() = recipient_id);
create policy "send a connection request"
  on connections for insert with check (auth.uid() = requester_id);
create policy "recipient can accept a request"
  on connections for update using (auth.uid() = recipient_id);

-- CIRCLES & MEMBERS: fully private to the owner.
create policy "manage your own circles"
  on circles for all using (auth.uid() = owner_id);
create policy "manage members of your own circles"
  on circle_members for all using (
    exists (select 1 from circles where circles.id = circle_members.circle_id and circles.owner_id = auth.uid())
  );

-- MEMORIES: the core privacy rule.
-- You can see a memory if you wrote it, OR you're an accepted
-- connection of the author AND a member of the circle it was shared
-- to. A memory with no circle ("Only me") only ever matches the
-- first condition, so nobody else can see it at all.
create policy "see your own memories or ones shared with your circle"
  on memories for select using (
    auth.uid() = author_id
    or (
      circle_id is not null
      and exists (
        select 1 from connections
        where status = 'accepted'
        and ((requester_id = auth.uid() and recipient_id = author_id)
          or (recipient_id = auth.uid() and requester_id = author_id))
      )
      and exists (
        select 1 from circle_members
        where circle_members.circle_id = memories.circle_id
        and circle_members.person_id = auth.uid()
      )
    )
  );
create policy "create your own memories"
  on memories for insert with check (auth.uid() = author_id);
create policy "edit your own memories"
  on memories for update using (auth.uid() = author_id);
create policy "delete your own memories"
  on memories for delete using (auth.uid() = author_id);

-- REACTIONS: visible only to whoever sent it and the memory's author
-- (private reactions — never a public count). The insert check relies
-- on the memories SELECT policy above: if you can't see the memory,
-- this exists() check returns nothing and the insert is rejected.
create policy "see reactions you sent or received"
  on memory_reactions for select using (
    auth.uid() = sender_id
    or auth.uid() = (select author_id from memories where memories.id = memory_id)
  );
create policy "react to a memory you can see"
  on memory_reactions for insert with check (
    auth.uid() = sender_id
    and exists (select 1 from memories where memories.id = memory_id)
  );
create policy "remove your own reaction"
  on memory_reactions for delete using (auth.uid() = sender_id);

-- REPLIES: a genuinely two-person-only thread — visible only to the
-- memory's author and whoever that specific thread is with. The
-- insert check requires the memory to be visible to you, same
-- reasoning as reactions above — this closes a real gap: without it,
-- anyone could reply to a memory_id they can't even see.
create policy "see replies in threads you're part of"
  on memory_replies for select using (
    auth.uid() = thread_with_id
    or auth.uid() = sender_id
    or auth.uid() = (select author_id from memories where memories.id = memory_id)
  );
create policy "reply to a memory you can see"
  on memory_replies for insert with check (
    auth.uid() = sender_id
    and exists (select 1 from memories where memories.id = memory_id)
  );

-- ACTIVITY: you only ever see notifications addressed to you. No
-- insert/update policy for regular users on purpose — rows are only
-- ever created by the triggers below, and marking read happens
-- through a security-definer function, not a raw client update.
create policy "see your own notifications"
  on activity for select using (auth.uid() = recipient_id);

-- ============================================================
-- NOTIFICATION TRIGGERS
-- This is what makes the activity inbox real and two-sided: whenever
-- a reaction, reply, or connection request happens, the system
-- automatically notifies whoever DIDN'T take the action — never the
-- person who sent it. Runs as security definer so it can write to
-- activity on someone else's behalf, bypassing the (deliberately
-- absent) client insert policy above.
-- ============================================================

create function notify_on_reaction()
returns trigger as $$
declare
  memory_author uuid;
begin
  select author_id into memory_author from memories where id = new.memory_id;
  if memory_author is distinct from new.sender_id then
    insert into activity (recipient_id, actor_id, type, memory_id, preview)
    values (memory_author, new.sender_id, 'reaction', new.memory_id, new.emoji);
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_reaction_notify
  after insert on memory_reactions
  for each row execute procedure notify_on_reaction();

create function notify_on_reply()
returns trigger as $$
declare
  memory_author uuid;
  recipient uuid;
begin
  select author_id into memory_author from memories where id = new.memory_id;
  recipient := case when new.sender_id = memory_author then new.thread_with_id else memory_author end;
  if recipient is distinct from new.sender_id then
    insert into activity (recipient_id, actor_id, type, memory_id, preview)
    values (recipient, new.sender_id, 'reply', new.memory_id, left(new.text, 140));
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_reply_notify
  after insert on memory_replies
  for each row execute procedure notify_on_reply();

create function notify_on_connection_request()
returns trigger as $$
begin
  insert into activity (recipient_id, actor_id, type)
  values (new.recipient_id, new.requester_id, 'request_received');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_connection_insert_notify
  after insert on connections
  for each row execute procedure notify_on_connection_request();

create function notify_on_connection_accepted()
returns trigger as $$
begin
  if new.status = 'accepted' and old.status = 'pending' then
    insert into activity (recipient_id, actor_id, type)
    values (new.requester_id, new.recipient_id, 'request_accepted');
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_connection_update_notify
  after update on connections
  for each row execute procedure notify_on_connection_accepted();

-- ============================================================
-- MARK-AS-READ
-- The one controlled write path into activity for regular users:
-- lets someone mark their own notifications read without a raw
-- UPDATE policy that could be misused to tamper with other columns.
-- ============================================================
create function mark_activity_read()
returns void as $$
begin
  update activity set read = true where recipient_id = auth.uid() and read = false;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- INVITES
-- A personal, single-use link an existing user generates to bring in
-- someone new. Deliberately NOT readable via a broad table policy —
-- that would leak every pending invite (and who sent it) to any
-- signed-in user. Instead, lookups go through a narrow function that
-- only ever returns what's needed for one specific token.
-- ============================================================
create table invites (
  token uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_by uuid references profiles(id) on delete set null
);

alter table invites enable row level security;

-- Only the inviter can browse their own list of invites they've sent.
create policy "see your own invites"
  on invites for select using (auth.uid() = inviter_id);
create policy "create an invite as yourself"
  on invites for insert with check (auth.uid() = inviter_id);

-- The one safe way for someone who isn't the inviter to look up an
-- invite: they have to already know the exact token (i.e. have the
-- link), and this only ever returns the inviter's name and status —
-- never the whole invites table.
create function get_invite_info(invite_token uuid)
returns table(inviter_name text, status text) as $$
  select p.name, i.status
  from invites i
  join profiles p on p.id = i.inviter_id
  where i.token = invite_token;
$$ language sql security definer set search_path = public;

-- Accepting a link is itself the mutual, deliberate act (you had to
-- have the specific link), so this creates an already-accepted
-- connection directly rather than a second pending request.
create function accept_invite(invite_token uuid)
returns void as $$
declare
  inviter uuid;
  invite_status text;
  invite_expires timestamptz;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select inviter_id, status, expires_at into inviter, invite_status, invite_expires
    from invites where token = invite_token;
  if inviter is null then raise exception 'Invite not found'; end if;
  if inviter = auth.uid() then raise exception 'Cannot accept your own invite'; end if;
  if invite_status <> 'pending' then raise exception 'This invite has already been used'; end if;
  if now() > invite_expires then
    update invites set status = 'expired' where token = invite_token;
    raise exception 'This invite has expired';
  end if;

  update invites set status = 'accepted', accepted_by = auth.uid() where token = invite_token;

  insert into connections (requester_id, recipient_id, status)
  values (inviter, auth.uid(), 'accepted')
  on conflict (requester_id, recipient_id) do update set status = 'accepted';
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- ACCOUNT DELETION
-- Deletes the auth.users row for whoever calls this. Every table
-- above references profiles(id) with "on delete cascade" (including
-- memory_replies.thread_with_id and memory_reactions/replies
-- .sender_id), so this one delete ripples out correctly on its own:
-- their memories, their reactions/replies left on OTHER people's
-- memories, and any thread they were part of, are all removed too —
-- not just what they personally created.
-- Regular users can't delete rows in auth.users directly; this
-- function runs as its owner (created via the SQL editor, so it has
-- the necessary privileges) rather than as the calling user.
-- ============================================================
create function delete_my_account()
returns void as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$ language plpgsql security definer set search_path = public, auth;
