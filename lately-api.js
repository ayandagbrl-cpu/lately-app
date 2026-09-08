// ============================================================
// LATELY — connection layer between the frontend and Supabase.
//
// Setup:
//   1. Create a project at supabase.com, run schema.sql in its SQL Editor.
//   2. In Storage, create two buckets: "avatars" and "media" (both public
//      read is fine for now — actual visibility is enforced by who you
//      send someone a memory's URL to, same as any signed asset link).
//   3. Fill in SUPABASE_URL / SUPABASE_ANON_KEY below from
//      Project Settings → API. The anon key is safe to expose client-side —
//      it only grants what the RLS policies in schema.sql allow.
//
// This file replaces the local `let memories = []` style state in the
// current prototype's app.js with real calls to a real database. Wiring
// the existing UI to call these functions instead of local arrays is the
// next step after this.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://mxcgkifkjqcfdofsdvmh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14Y2draWZranFjZmRvZnNkdm1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NTE4NzIsImV4cCI6MjEwNDQyNzg3Mn0.WTmb8FqFeaBufg-3m-gQtdSasAQH1FhUrRpCyNlbzw8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function requireNoError({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------- AUTH ----------

export async function signUp(email, password, name) {
  return requireNoError(await supabase.auth.signUp({
    email, password, options: { data: { name } }
  }));
}

export async function signIn(email, password) {
  return requireNoError(await supabase.auth.signInWithPassword({ email, password }));
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Call once at app startup; fires again on sign-in/sign-out so the UI
// can react (e.g. show onboarding vs. the feed).
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
}

// ---------- PROFILE ----------

export async function getMyProfile() {
  const user = await getCurrentUser();
  if (!user) return null;
  return requireNoError(await supabase.from('profiles').select('*').eq('id', user.id).single());
}

export async function updateProfile({ name, bio }) {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('profiles').update({ name, bio }).eq('id', user.id).select().single());
}

export async function uploadAvatar(file) {
  const user = await getCurrentUser();
  const path = `${user.id}/${Date.now()}-${file.name}`;
  requireNoError(await supabase.storage.from('avatars').upload(path, file, { upsert: true }));
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  await updateProfile({ avatar_url: data.publicUrl });
  return data.publicUrl;
}

// Matches the "Search by name or username" flow.
export async function searchProfiles(query) {
  return requireNoError(await supabase.from('profiles')
    .select('id, name, username, avatar_url')
    .or(`name.ilike.%${query}%,username.ilike.%${query}%`)
    .limit(20));
}

// ---------- CONNECTIONS (the "People" tab + mutual approval) ----------

export async function sendConnectionRequest(recipientId) {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('connections')
    .insert({ requester_id: user.id, recipient_id: recipientId })
    .select().single());
}

export async function acceptConnectionRequest(connectionId) {
  return requireNoError(await supabase.from('connections')
    .update({ status: 'accepted' })
    .eq('id', connectionId)
    .select().single());
}

// Accepted connections — this is your real "People" list.
export async function getMyConnections() {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('connections')
    .select('*, requester:requester_id(id,name,avatar_url), recipient:recipient_id(id,name,avatar_url)')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`));
}

// Requests waiting on YOU to approve — feeds a "pending" section of People.
export async function getPendingRequests() {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('connections')
    .select('*, requester:requester_id(id,name,avatar_url)')
    .eq('recipient_id', user.id)
    .eq('status', 'pending'));
}

// Requests YOU sent that the other person hasn't approved yet.
export async function getSentRequests() {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('connections')
    .select('*, recipient:recipient_id(id,name,avatar_url)')
    .eq('requester_id', user.id)
    .eq('status', 'pending'));
}

// ---------- CIRCLES ----------

export async function getMyCircles() {
  return requireNoError(await supabase.from('circles').select('*, circle_members(person_id)'));
}

export async function createCircle(name) {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('circles').insert({ owner_id: user.id, name }).select().single());
}

export async function deleteCircle(circleId) {
  const { error } = await supabase.from('circles').delete().eq('id', circleId);
  if (error) throw error;
}

export async function addCircleMember(circleId, personId) {
  const { error } = await supabase.from('circle_members').insert({ circle_id: circleId, person_id: personId });
  if (error) throw error;
}

export async function removeCircleMember(circleId, personId) {
  const { error } = await supabase.from('circle_members').delete()
    .eq('circle_id', circleId).eq('person_id', personId);
  if (error) throw error;
}

// ---------- MEMORIES ----------

// RLS on the memories table does the actual filtering — this returns
// exactly what you're allowed to see (your own + whatever your circles
// grant you), nothing more, straight from the database.
export async function getFeed() {
  return requireNoError(await supabase.from('memories')
    .select('*, author:author_id(id,name,avatar_url), circle:circle_id(id,name)')
    .order('created_at', { ascending: false }));
}

export async function getMyMemories() {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('memories')
    .select('*, circle:circle_id(id,name)').eq('author_id', user.id).order('memory_date', { ascending: false }));
}

// Batch fetch of the current user's own reaction per memory (a memory only
// ever shows YOUR reaction state, same as the tapback toggle behavior).
export async function getMyReactions(memoryIds) {
  const user = await getCurrentUser();
  if (!memoryIds.length) return {};
  const rows = requireNoError(await supabase.from('memory_reactions')
    .select('memory_id, emoji').eq('sender_id', user.id).in('memory_id', memoryIds));
  return Object.fromEntries(rows.map(row => [row.memory_id, row.emoji]));
}

export async function uploadMemoryMedia(file, type) {
  const user = await getCurrentUser();
  const path = `${user.id}/${Date.now()}-${file.name}`;
  requireNoError(await supabase.storage.from('media').upload(path, file));
  const { data } = supabase.storage.from('media').getPublicUrl(path);
  return { [`${type}_url`]: data.publicUrl };
}

export async function createMemory({ title, note, chapter, circleId, date, mediaUrlFields }) {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('memories').insert({
    author_id: user.id, title, note, chapter,
    circle_id: circleId ?? null,
    memory_date: date,
    ...mediaUrlFields
  }).select().single());
}

export async function updateMemory(memoryId, fields) {
  return requireNoError(await supabase.from('memories').update(fields).eq('id', memoryId).select().single());
}

export async function deleteMemory(memoryId) {
  const { error } = await supabase.from('memories').delete().eq('id', memoryId);
  if (error) throw error;
}

// ---------- REACTIONS (tapbacks) ----------

// upsert: tapping the same emoji again just re-sends it; tapping a
// different one replaces it (one reaction per person per memory).
export async function setReaction(memoryId, emoji) {
  const user = await getCurrentUser();
  const { error } = await supabase.from('memory_reactions')
    .upsert({ memory_id: memoryId, sender_id: user.id, emoji });
  if (error) throw error;
}

export async function removeReaction(memoryId) {
  const user = await getCurrentUser();
  const { error } = await supabase.from('memory_reactions')
    .delete().eq('memory_id', memoryId).eq('sender_id', user.id);
  if (error) throw error;
}

// ---------- REPLIES (private threads) ----------

export async function getThread(memoryId, threadWithId) {
  return requireNoError(await supabase.from('memory_replies')
    .select('*, sender:sender_id(id,name,avatar_url)')
    .eq('memory_id', memoryId).eq('thread_with_id', threadWithId)
    .order('created_at', { ascending: true }));
}

export async function sendReply(memoryId, threadWithId, text) {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('memory_replies')
    .insert({ memory_id: memoryId, thread_with_id: threadWithId, sender_id: user.id, text })
    .select().single());
}

// ---------- ACTIVITY (inbox) ----------

export async function getActivity() {
  return requireNoError(await supabase.from('activity')
    .select('*, actor:actor_id(id,name,avatar_url), memory:memory_id(id,title)')
    .order('created_at', { ascending: false }));
}

export async function markActivityRead() {
  const { error } = await supabase.rpc('mark_activity_read');
  if (error) throw error;
}

// ---------- INVITES ----------

export async function createInvite() {
  const user = await getCurrentUser();
  return requireNoError(await supabase.from('invites')
    .insert({ inviter_id: user.id }).select('token').single());
}

// Safe to call before the invitee has any connection to the inviter —
// goes through the narrow RPC, not a direct table read.
export async function getInviteInfo(token) {
  return requireNoError(await supabase.rpc('get_invite_info', { invite_token: token }));
}

export async function acceptInvite(token) {
  const { error } = await supabase.rpc('accept_invite', { invite_token: token });
  if (error) throw error;
}

// ---------- ACCOUNT DELETION ----------

// Permanently deletes the account and everything tied to it, including
// replies/reactions left on OTHER people's memories (see schema.sql for
// the cascade reasoning). There is no undo — the caller is responsible
// for confirming with the person before calling this.
export async function deleteMyAccount() {
  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw error;
  await supabase.auth.signOut();
}
