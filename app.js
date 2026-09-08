import {
  supabase, onAuthChange, getCurrentUser, signUp, signIn, signOut,
  getMyProfile, updateProfile, uploadAvatar, searchProfiles,
  sendConnectionRequest, acceptConnectionRequest, getMyConnections, getPendingRequests,
  getMyCircles, createCircle, deleteCircle, addCircleMember, removeCircleMember,
  getFeed, uploadMemoryMedia, createMemory, updateMemory, deleteMemory,
  setReaction, getThread, sendReply,
  getActivity, markActivityRead,
  createInvite, getInviteInfo, acceptInvite,
  deleteMyAccount
} from "./lately-api.js";

// ---------- STATE ----------
// Everything here is loaded from Supabase, not invented locally. IDs
// throughout this file are real UUID strings from Postgres.
let currentUser = null;     // merged auth user + profiles row
let circles = [];           // [{id, name, circle_members:[{person_id}]}], plus a virtual "Only me"
let connections = [];       // accepted people
let pendingRequests = [];   // requests waiting on YOU to approve
let memories = [];
let activity = [];
let pendingInviteToken = new URLSearchParams(window.location.search).get("invite");

const feed = document.querySelector("#feed");
const timeline = document.querySelector("#timeline");
const peopleList = document.querySelector("#people-list");
const composer = document.querySelector("#composer");
const replies = document.querySelector("#replies");

function escapeHTML(value) { const box = document.createElement("div"); box.textContent = value; return box.innerHTML; }
function emptyState({ icon, title, text, actionLabel, action }) {
  return `<div class="empty-state"><div class="empty-icon"><i data-lucide="${icon}"></i></div><h3>${title}</h3><p>${text}</p>${actionLabel ? `<button class="empty-action" data-empty-action="${action}">${actionLabel}</button>` : ""}</div>`;
}
function otherPerson(connection) {
  return connection.requester_id === currentUser.id ? connection.recipient : connection.requester;
}

// ============================================================
// AUTH — welcome → sign up (with email confirmation) or sign in
// ============================================================
function showOnboardingStep(step) {
  document.querySelectorAll(".onboarding-step").forEach(el => el.classList.toggle("active", el.dataset.step === String(step)));
}
document.querySelector("#go-to-signin").addEventListener("click", () => showOnboardingStep("signin"));
document.querySelector("#back-to-welcome").addEventListener("click", () => showOnboardingStep(0));
document.querySelector("#confirm-email-to-signin").addEventListener("click", () => showOnboardingStep("signin"));

document.querySelector("#submit-signin").addEventListener("click", async () => {
  const email = document.querySelector("#signin-email").value.trim();
  const password = document.querySelector("#signin-password").value;
  const errorEl = document.querySelector("#signin-error");
  errorEl.classList.add("hidden");
  try {
    authHandled = true;
    await signIn(email, password);
    await afterAuth({ freshSignIn: true });
  } catch (err) {
    authHandled = false;
    errorEl.textContent = err.message || "Couldn't sign you in. Check your email and password.";
    errorEl.classList.remove("hidden");
  }
});

document.querySelector("#onboarding-step1-continue").addEventListener("click", async () => {
  const nameInput = document.querySelector("#onboarding-name");
  const name = nameInput.value.trim();
  const email = document.querySelector("#signup-email").value.trim();
  const password = document.querySelector("#signup-password").value;
  const errorEl = document.querySelector("#signup-error");
  errorEl.classList.add("hidden");
  if (!name) { document.querySelector("#name-required-hint").classList.remove("hidden"); nameInput.classList.add("error"); nameInput.focus(); return; }
  document.querySelector("#name-required-hint").classList.add("hidden"); nameInput.classList.remove("error");
  try {
    authHandled = true;
    const { session } = await signUp(email, password, name);
    if (session) {
      // Project has email confirmation off — session is live immediately.
      await afterAuth({ freshSignIn: true });
    } else {
      // Normal case: Supabase requires confirming via the emailed link first.
      authHandled = false;
      showOnboardingStep("confirm-email");
    }
  } catch (err) {
    authHandled = false;
    errorEl.textContent = err.message || "Something went wrong creating your account.";
    errorEl.classList.remove("hidden");
  }
});

// Called once we actually have a session — either just now via the
// onboarding UI (freshSignIn: show the "find your people" steps once)
// or because a session already existed on page load (skip straight in).
async function afterAuth({ freshSignIn }) {
  currentUser = await getMyProfile();
  if (pendingInviteToken) {
    try { await acceptInvite(pendingInviteToken); } catch (err) { /* invite invalid/expired/own link - ignore quietly */ }
    pendingInviteToken = null;
    window.history.replaceState({}, "", window.location.pathname);
  }
  await loadEverything();
  document.querySelector(".profile h2").textContent = currentUser.name;
  const bioEl = document.querySelector(".profile p");
  if (currentUser.bio) { bioEl.textContent = currentUser.bio; bioEl.classList.remove("placeholder"); }
  else { bioEl.textContent = "No bio yet"; bioEl.classList.add("placeholder"); }
  document.querySelector("#avatar-initials").textContent = initialsOf(currentUser.name);
  if (currentUser.avatar_url) {
    const avatarButton = document.querySelector("#avatar-button");
    avatarButton.style.backgroundImage = `url(${currentUser.avatar_url})`;
    avatarButton.classList.add("has-photo");
  }
  if (freshSignIn) { showOnboardingStep(2); }
  else { document.querySelector("#onboarding").classList.add("hidden"); }
}

async function loadEverything() {
  const [circlesData, connectionsData, requestsData, memoriesData, activityData] = await Promise.all([
    getMyCircles(), getMyConnections(), getPendingRequests(), getFeed(), getActivity()
  ]);
  circles = [{ id: null, name: "Only me" }, ...circlesData];
  connections = connectionsData;
  pendingRequests = requestsData;
  memories = memoriesData;
  activity = activityData;
  render();
  updateActivityBadge();
}

function initialsOf(name) { return (name || "").split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase() || "?"; }

// On load: if a session already exists (returning visit), skip onboarding
// entirely. Otherwise wait at the welcome screen.
let authHandled = false;
onAuthChange(async user => {
  if (user && !authHandled) { authHandled = true; await afterAuth({ freshSignIn: false }); }
});
getCurrentUser().then(async user => {
  if (user && !authHandled) { authHandled = true; await afterAuth({ freshSignIn: false }); }
});

// ============================================================
// RENDER — feed, timeline, people. Pulls from the state loaded above,
// never invents anything locally.
// ============================================================
function render() {
  if (memories.length === 0 && connections.length === 0) {
    feed.innerHTML = emptyState({ icon:"user-round-plus", title:"Add your people", text:"Once you add friends and family, their moments will show up here.", actionLabel:"Find your people", action:"find-people" });
  } else if (memories.length === 0) {
    feed.innerHTML = emptyState({ icon:"image-plus", title:"Nothing shared yet", text:"Be the first to add a moment.", actionLabel:"Add a memory", action:"add-memory" });
  } else {
    feed.innerHTML = memories.map(memory => {
      const isOwn = memory.author_id === currentUser.id;
      const circleName = circles.find(c => c.id === memory.circle_id)?.name || (memory.circle_id ? "" : "Only me");
      return `<article class="feed-item" data-id="${memory.id}"><div class="person"><div class="avatar">${initialsOf(memory.author.name)}</div><div><strong>${escapeHTML(memory.author.name)}</strong><small>${new Date(memory.created_at).toLocaleDateString()} · ${escapeHTML(circleName)}</small></div></div><h3>${escapeHTML(memory.title)}</h3><p>${escapeHTML(memory.note || "")}</p>${memory.image_url ? `<img class="memory-photo" alt="Memory shared by ${escapeHTML(memory.author.name)}" src="${memory.image_url}">` : ""}${memory.video_url ? `<video class="memory-photo" src="${memory.video_url}" controls></video>` : ""}${memory.audio_url ? `<audio class="memory-audio" src="${memory.audio_url}" controls></audio>` : ""}${isOwn ? "" : `<div class="memory-actions"><button data-action="react" data-id="${memory.id}">Send a reaction</button><button data-action="reply" data-id="${memory.id}">Reply privately</button></div>`}</article>`;
    }).join("");
  }

  const myMemories = memories.filter(memory => memory.author_id === currentUser?.id);
  if (myMemories.length === 0) {
    timeline.innerHTML = emptyState({ icon:"clock-3", title:"Your story starts here", text:"Add your first memory to begin your timeline.", actionLabel:"Add a memory", action:"add-memory" });
  } else {
    const chapters = [...new Set(myMemories.map(memory => memory.chapter || "My memories"))];
    timeline.innerHTML = chapters.map(chapter => `<section class="chapter"><h4>${escapeHTML(chapter)}</h4>${myMemories.filter(memory => (memory.chapter || "My memories") === chapter).map(memory => `<div class="event" data-id="${memory.id}"><div class="event-date">${new Date(memory.memory_date).toLocaleDateString(undefined,{month:"short"}).toUpperCase()}<b>${new Date(memory.memory_date).getDate()}</b></div><div><strong>${escapeHTML(memory.title)}</strong><span>${escapeHTML(memory.note || "A memory from this day.")}</span></div></div>`).join("")}</section>`).join("");
  }

  if (pendingRequests.length === 0 && connections.length === 0) {
    peopleList.innerHTML = emptyState({ icon:"users-round", title:"No one here yet", text:"Add the people whose life you want to keep up with.", actionLabel:"Find your people", action:"find-people" });
  } else {
    const pendingHTML = pendingRequests.map(request => `<div class="person-row pending" data-request-id="${request.id}"><div class="avatar">${initialsOf(request.requester.name)}</div><div><b>${escapeHTML(request.requester.name)}</b><span>Wants to add you · tap to approve</span></div></div>`).join("");
    const connectedHTML = connections.map(connection => { const person = otherPerson(connection); return `<div class="person-row"><div class="avatar">${initialsOf(person.name)}</div><div><b>${escapeHTML(person.name)}</b><span>In your circle</span></div></div>`; }).join("");
    peopleList.innerHTML = pendingHTML + connectedHTML;
  }

  if (window.lucide) window.lucide.createIcons();
}

peopleList.addEventListener("click", async event => {
  const row = event.target.closest(".person-row.pending");
  if (!row) return;
  await acceptConnectionRequest(row.dataset.requestId);
  const [connectionsData, requestsData] = await Promise.all([getMyConnections(), getPendingRequests()]);
  connections = connectionsData; pendingRequests = requestsData;
  render();
});

// ============================================================
// TABS
// ============================================================
document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(item => item.classList.remove("active"));
  document.querySelectorAll(".screen").forEach(screen => screen.classList.remove("active"));
  tab.classList.add("active");
  document.querySelector(`#${tab.dataset.screen}`).classList.add("active");
}));
document.body.addEventListener("click", event => {
  const trigger = event.target.closest("[data-empty-action]");
  if (!trigger) return;
  if (trigger.dataset.emptyAction === "add-memory") openComposer();
  else if (trigger.dataset.emptyAction === "find-people") { document.querySelector('.tab[data-screen="people-screen"]').click(); openPeopleStep("choices"); }
});

// ============================================================
// TAPBACK REACTIONS
// ============================================================
let tapbackTargetId = null;
const tapbackPicker = document.querySelector("#tapback-picker");
const tapbackBackdrop = document.querySelector("#tapback-backdrop");
function openTapback(button, memoryId) {
  tapbackTargetId = memoryId;
  const phoneRect = document.querySelector(".phone").getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const top = Math.max(buttonRect.top - phoneRect.top - 54, 8);
  const left = Math.min(Math.max(buttonRect.left - phoneRect.left, 8), phoneRect.width - 220);
  tapbackPicker.style.top = `${top}px`;
  tapbackPicker.style.left = `${left}px`;
  tapbackBackdrop.classList.remove("hidden");
  tapbackPicker.classList.remove("hidden");
  requestAnimationFrame(() => tapbackPicker.classList.add("open"));
}
function closeTapback() { tapbackPicker.classList.remove("open"); setTimeout(() => { tapbackPicker.classList.add("hidden"); tapbackBackdrop.classList.add("hidden"); }, 160); }
tapbackBackdrop.addEventListener("click", closeTapback);
tapbackPicker.addEventListener("click", async event => {
  const option = event.target.closest("[data-emoji]");
  if (!option) return closeTapback();
  await setReaction(tapbackTargetId, option.dataset.emoji);
  memories = await getFeed();
  render();
  closeTapback();
});

// ============================================================
// COMPOSER — create or edit a memory
// ============================================================
let editingMemoryId = null;
let selectedCircleId = null;
let selectedDate = new Date();
const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function formatSelectedDate(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  return d.getTime() === today.getTime() ? "Today" : `${monthNames[date.getMonth()].slice(0, 3)} ${date.getDate()}, ${date.getFullYear()}`;
}
function circleName(id) { return circles.find(c => c.id === id)?.name || "Only me"; }

function openComposer(memory) {
  document.querySelector("#memory-form").reset();
  clearAttachment();
  editingMemoryId = memory ? memory.id : null;
  document.querySelector("#composer-title").textContent = memory ? "Edit memory" : "New memory";
  document.querySelector("#composer-share").textContent = memory ? "Save" : "Share";
  if (memory) {
    document.querySelector("#memory-title").value = memory.title;
    document.querySelector("#memory-note").value = memory.note || "";
    selectedDate = new Date(memory.memory_date);
    selectedCircleId = memory.circle_id;
    if (memory.image_url) setAttachment({ type:"photo", url:memory.image_url, existing:true });
    else if (memory.video_url) setAttachment({ type:"video", url:memory.video_url, existing:true });
    else if (memory.audio_url) setAttachment({ type:"audio", url:memory.audio_url, existing:true });
  } else {
    selectedDate = new Date();
    selectedCircleId = null;
  }
  document.querySelector("#memory-date").textContent = formatSelectedDate(selectedDate);
  document.querySelector("#audience-label").textContent = circleName(selectedCircleId);
  composer.showModal();
}
document.querySelector("#new-memory").addEventListener("click", () => openComposer());
document.querySelector("#prompt-memory").addEventListener("click", () => openComposer());
document.querySelector("#cancel-composer").addEventListener("click", () => composer.close());

document.querySelector("#memory-form").addEventListener("submit", async event => {
  event.preventDefault();
  const title = document.querySelector("#memory-title").value.trim();
  if (!title) return;
  const note = document.querySelector("#memory-note").value.trim();
  const shareButton = document.querySelector("#composer-share");
  shareButton.textContent = "Saving…"; shareButton.disabled = true;
  try {
    let mediaUrlFields = {};
    if (attachment && !attachment.existing && attachment.file) {
      mediaUrlFields = await uploadMemoryMedia(attachment.file, attachment.type);
    } else if (attachment && attachment.existing) {
      // Unchanged existing attachment — keep it.
      if (attachment.type === "photo") mediaUrlFields = { image_url: attachment.url };
      if (attachment.type === "video") mediaUrlFields = { video_url: attachment.url };
      if (attachment.type === "audio") mediaUrlFields = { audio_url: attachment.url };
    } else {
      mediaUrlFields = { image_url: null, video_url: null, audio_url: null };
    }
    const dateStr = selectedDate.toISOString().slice(0, 10);
    if (editingMemoryId) {
      await updateMemory(editingMemoryId, { title, note, circle_id: selectedCircleId, memory_date: dateStr, ...mediaUrlFields });
    } else {
      await createMemory({ title, note, circleId: selectedCircleId, date: dateStr, mediaUrlFields });
    }
    memories = await getFeed();
    render();
    composer.close();
  } catch (err) {
    alert(err.message || "Couldn't save that memory. Try again.");
  } finally {
    shareButton.textContent = editingMemoryId ? "Save" : "Share"; shareButton.disabled = false;
  }
});

// ---------- attachments (photo / video / voice) ----------
let attachment = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
function clearAttachment() { attachment = null; renderAttachmentPreview(); document.querySelector("#photo-input").value = ""; document.querySelector("#video-input").value = ""; document.querySelector("#audio-input").value = ""; }
function setAttachment(att) { attachment = att; renderAttachmentPreview(); }
function renderAttachmentPreview() {
  const box = document.querySelector("#attachment-preview");
  if (!attachment) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  const media = attachment.type === "photo" ? `<img src="${attachment.url}" alt="Attached photo">` : attachment.type === "video" ? `<video src="${attachment.url}" controls></video>` : attachment.type === "audio" ? `<audio src="${attachment.url}" controls></audio>` : `<p class="hint">${attachment.message}</p>`;
  box.innerHTML = media + (attachment.url ? `<button type="button" id="remove-attachment">Remove</button>` : "");
  if (attachment.url) document.querySelector("#remove-attachment").addEventListener("click", clearAttachment);
}
function startVoiceRecording() {
  const voiceButton = document.querySelector("#attach-voice");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setAttachment({ type:"error", message:"Voice recording isn't available in this browser/context." }); return; }
  navigator.mediaDevices.getUserMedia({ audio:true }).then(stream => {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = event => { if (event.data.size > 0) recordedChunks.push(event.data); };
    mediaRecorder.onstop = () => {
      const file = new File([new Blob(recordedChunks, { type:"audio/webm" })], `voice-${Date.now()}.webm`, { type:"audio/webm" });
      setAttachment({ type:"audio", url:URL.createObjectURL(file), file });
      stream.getTracks().forEach(track => track.stop());
      isRecording = false;
      voiceButton.querySelector("span").textContent = "Voice note";
      voiceButton.classList.remove("recording");
    };
    mediaRecorder.start();
    isRecording = true;
    voiceButton.querySelector("span").textContent = "Stop";
    voiceButton.classList.add("recording");
  }).catch(() => setAttachment({ type:"error", message:"Couldn't access your microphone. Check your browser's permission settings and try again." }));
}
function triggerFileInput(selector, useCapture) { const input = document.querySelector(selector); if (useCapture) input.setAttribute("capture", "environment"); else input.removeAttribute("capture"); input.click(); }
const mediaChoiceSheet = document.querySelector("#media-choice-sheet");
const mediaChoiceConfig = {
  photo: { primary:"Take Photo", secondary:"Choose from Library", primaryAction:() => triggerFileInput("#photo-input", true), secondaryAction:() => triggerFileInput("#photo-input", false) },
  video: { primary:"Record Video", secondary:"Choose from Library", primaryAction:() => triggerFileInput("#video-input", true), secondaryAction:() => triggerFileInput("#video-input", false) },
  voice: { primary:"Record Audio", secondary:"Upload Audio File", primaryAction:startVoiceRecording, secondaryAction:() => document.querySelector("#audio-input").click() }
};
function openMediaChoice(type) { const config = mediaChoiceConfig[type]; document.querySelector("#media-choice-primary").textContent = config.primary; document.querySelector("#media-choice-secondary").textContent = config.secondary; mediaChoiceSheet.dataset.type = type; mediaChoiceSheet.showModal(); }
document.querySelector("#attach-photo").addEventListener("click", () => openMediaChoice("photo"));
document.querySelector("#attach-video").addEventListener("click", () => openMediaChoice("video"));
document.querySelector("#attach-voice").addEventListener("click", () => { if (isRecording) { mediaRecorder.stop(); return; } openMediaChoice("voice"); });
document.querySelector("#media-choice-primary").addEventListener("click", () => { mediaChoiceSheet.close(); mediaChoiceConfig[mediaChoiceSheet.dataset.type].primaryAction(); });
document.querySelector("#media-choice-secondary").addEventListener("click", () => { mediaChoiceSheet.close(); mediaChoiceConfig[mediaChoiceSheet.dataset.type].secondaryAction(); });
document.querySelector("#media-choice-cancel").addEventListener("click", () => mediaChoiceSheet.close());
document.querySelector("#photo-input").addEventListener("change", event => { const file = event.target.files[0]; if (!file) return; setAttachment({ type:"photo", url:URL.createObjectURL(file), file }); });
document.querySelector("#video-input").addEventListener("change", event => { const file = event.target.files[0]; if (!file) return; setAttachment({ type:"video", url:URL.createObjectURL(file), file }); });
document.querySelector("#audio-input").addEventListener("change", event => { const file = event.target.files[0]; if (!file) return; setAttachment({ type:"audio", url:URL.createObjectURL(file), file }); });

// ---------- date picker (today or past only — no scheduling) ----------
let calendarViewDate = new Date();
function renderCalendar() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  document.querySelector("#cal-month-label").textContent = `${monthNames[month]} ${year}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startOffset = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let cells = "";
  for (let i = 0; i < startOffset; i++) cells += `<span class="cal-cell empty"></span>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(year, month, d);
    const isFuture = cellDate > today;
    const isSelected = cellDate.toDateString() === selectedDate.toDateString();
    const isToday = cellDate.toDateString() === today.toDateString();
    cells += `<button type="button" class="cal-cell${isSelected ? " selected" : ""}${isToday ? " today" : ""}" ${isFuture ? "disabled" : ""} data-date="${cellDate.toISOString()}">${d}</button>`;
  }
  document.querySelector("#calendar-grid").innerHTML = cells;
  document.querySelector("#cal-next").disabled = new Date(year, month + 1, 1) > today;
}
document.querySelector("#date-button").addEventListener("click", () => { calendarViewDate = new Date(selectedDate); renderCalendar(); document.querySelector("#date-picker").showModal(); });
document.querySelector("#close-date-picker").addEventListener("click", () => document.querySelector("#date-picker").close());
document.querySelector("#cal-prev").addEventListener("click", () => { calendarViewDate.setMonth(calendarViewDate.getMonth() - 1); renderCalendar(); });
document.querySelector("#cal-next").addEventListener("click", () => { calendarViewDate.setMonth(calendarViewDate.getMonth() + 1); renderCalendar(); });
document.querySelector("#calendar-grid").addEventListener("click", event => {
  const cell = event.target.closest(".cal-cell:not(.empty)");
  if (!cell || cell.disabled) return;
  selectedDate = new Date(cell.dataset.date);
  document.querySelector("#memory-date").textContent = formatSelectedDate(selectedDate);
  document.querySelector("#date-picker").close();
});

// ---------- audience / circle picker ----------
const audiencePicker = document.querySelector("#audience-picker");
function renderAudienceList() {
  document.querySelector("#audience-list").innerHTML = circles.map(circle => `<button type="button" class="audience-row${circle.id === selectedCircleId ? " selected" : ""}" data-circle-id="${circle.id ?? ""}"><div><strong>${escapeHTML(circle.name)}</strong></div>${circle.id === selectedCircleId ? `<i data-lucide="check"></i>` : ""}</button>`).join("");
  if (window.lucide) window.lucide.createIcons();
}
document.querySelector("#audience-button").addEventListener("click", () => { renderAudienceList(); audiencePicker.showModal(); });
document.querySelector("#close-audience").addEventListener("click", () => audiencePicker.close());
document.querySelector("#audience-list").addEventListener("click", event => {
  const row = event.target.closest(".audience-row");
  if (!row) return;
  selectedCircleId = row.dataset.circleId || null;
  document.querySelector("#audience-label").textContent = circleName(selectedCircleId);
  renderAudienceList();
  audiencePicker.close();
});
document.querySelector("#new-circle-button").addEventListener("click", () => { audiencePicker.close(); document.querySelector("#new-circle-name").value = ""; document.querySelector("#new-circle-sheet").showModal(); });
document.querySelector("#cancel-new-circle").addEventListener("click", () => { document.querySelector("#new-circle-sheet").close(); audiencePicker.showModal(); });
document.querySelector("#save-new-circle").addEventListener("click", async () => {
  const name = document.querySelector("#new-circle-name").value.trim();
  if (!name) return;
  const newCircle = await createCircle(name);
  circles.push(newCircle);
  selectedCircleId = newCircle.id;
  document.querySelector("#audience-label").textContent = newCircle.name;
  document.querySelector("#new-circle-sheet").close();
});

// ============================================================
// REPLIES — private two-person threads
// ============================================================
let currentThreadMemoryId = null;
let currentThreadWithId = null;
async function openReplies(memory, threadWithId, threadWithName) {
  currentThreadMemoryId = memory.id;
  currentThreadWithId = threadWithId;
  document.querySelector("#reply-title").textContent = `Reply to ${threadWithName.split(" ")[0]}`;
  document.querySelector("#reply-context").innerHTML = `<small>Replying to ${escapeHTML(memory.author.name)}’s memory</small><strong>${escapeHTML(memory.title)}</strong><br>${escapeHTML(memory.note || "")}`;
  await renderMessages();
  replies.showModal();
}
async function renderMessages() {
  const thread = await getThread(currentThreadMemoryId, currentThreadWithId);
  document.querySelector("#messages").innerHTML = thread.map(reply => `<div class="message ${reply.sender_id === currentUser.id ? "me" : ""}">${escapeHTML(reply.text)}</div>`).join("");
}
document.querySelector("#close-replies").addEventListener("click", () => replies.close());
document.querySelector("#reply-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.querySelector("#reply-input");
  const text = input.value.trim();
  if (!text) return;
  await sendReply(currentThreadMemoryId, currentThreadWithId, text);
  input.value = "";
  await renderMessages();
});

// ============================================================
// FEED / TIMELINE CLICKS — react, reply, open detail
// ============================================================
feed.addEventListener("click", async event => {
  const button = event.target.closest("button[data-id]");
  if (button) {
    const memory = memories.find(m => m.id === button.dataset.id);
    if (button.dataset.action === "react") { openTapback(button, button.dataset.id); return; }
    if (button.dataset.action === "reply" && memory) { openReplies(memory, currentUser.id, currentUser.name); return; }
    return;
  }
  if (event.target.closest("video, audio")) return;
  const item = event.target.closest(".feed-item");
  if (item) openMemoryDetail(item.dataset.id);
});
timeline.addEventListener("click", event => { const item = event.target.closest(".event"); if (item) openMemoryDetail(item.dataset.id); });

// ============================================================
// MEMORY DETAIL — view, edit, delete (own memories only)
// ============================================================
let detailMemoryId = null;
function openMemoryDetail(memoryId) { detailMemoryId = memoryId; renderDetail(); document.querySelector("#memory-detail").showModal(); }
function renderDetail() {
  const memory = memories.find(m => m.id === detailMemoryId);
  if (!memory) return;
  const isOwner = memory.author_id === currentUser.id;
  document.querySelector("#edit-memory").classList.toggle("hidden", !isOwner);
  document.querySelector("#detail-delete").classList.toggle("hidden", !isOwner);
  document.querySelector("#detail-body").innerHTML = `<div class="detail-person"><div class="avatar">${initialsOf(memory.author.name)}</div><div><strong>${escapeHTML(memory.author.name)}</strong><small>${new Date(memory.memory_date).toDateString()}</small></div></div><h1 class="detail-title">${escapeHTML(memory.title)}</h1>${memory.image_url ? `<img class="detail-media" src="${memory.image_url}" alt="Memory">` : ""}${memory.video_url ? `<video class="detail-media" src="${memory.video_url}" controls></video>` : ""}${memory.audio_url ? `<audio class="memory-audio" src="${memory.audio_url}" controls></audio>` : ""}${memory.note ? `<p class="detail-note">${escapeHTML(memory.note)}</p>` : ""}`;
}
document.querySelector("#close-detail").addEventListener("click", () => document.querySelector("#memory-detail").close());
document.querySelector("#edit-memory").addEventListener("click", () => { const memory = memories.find(m => m.id === detailMemoryId); if (!memory) return; document.querySelector("#memory-detail").close(); openComposer(memory); });
document.querySelector("#detail-delete").addEventListener("click", () => document.querySelector("#delete-confirm-sheet").showModal());
document.querySelector("#cancel-delete-sheet").addEventListener("click", () => document.querySelector("#delete-confirm-sheet").close());
document.querySelector("#confirm-delete").addEventListener("click", async () => {
  await deleteMemory(detailMemoryId);
  memories = await getFeed();
  document.querySelector("#delete-confirm-sheet").close();
  document.querySelector("#memory-detail").close();
  render();
});

// ============================================================
// ACTIVITY INBOX
// ============================================================
function updateActivityBadge() {
  const unread = activity.filter(entry => !entry.read).length;
  const badge = document.querySelector("#activity-badge");
  if (unread > 0) { badge.textContent = unread > 9 ? "9+" : unread; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
}
function renderActivity() {
  const list = document.querySelector("#activity-list");
  if (activity.length === 0) { list.innerHTML = emptyState({ icon:"bell", title:"Nothing yet", text:"When people react or reply to your memories, you'll see it here." }); if (window.lucide) window.lucide.createIcons(); return; }
  list.innerHTML = activity.slice().reverse().map(entry => `<button type="button" class="activity-row" data-memory-id="${entry.memory_id}" data-actor-id="${entry.actor_id}" data-actor-name="${escapeHTML(entry.actor.name)}"><div class="activity-icon ${entry.type}">${entry.type === "reaction" ? entry.preview : `<i data-lucide="message-circle"></i>`}</div><div class="activity-text"><strong>${escapeHTML(entry.actor.name)} ${entry.type === "reaction" ? "reacted to" : "replied to"} "${escapeHTML(entry.memory?.title || "a memory")}"</strong>${entry.type === "reply" && entry.preview ? `<span>${escapeHTML(entry.preview)}</span>` : ""}</div><span class="activity-time">${new Date(entry.created_at).toLocaleDateString()}</span></button>`).join("");
  if (window.lucide) window.lucide.createIcons();
}
document.querySelector("#activity-button").addEventListener("click", async () => {
  renderActivity();
  document.querySelector("#activity-sheet").showModal();
  if (activity.some(entry => !entry.read)) { await markActivityRead(); activity.forEach(entry => entry.read = true); updateActivityBadge(); }
});
document.querySelector("#close-activity").addEventListener("click", () => document.querySelector("#activity-sheet").close());
document.querySelector("#activity-list").addEventListener("click", event => {
  const row = event.target.closest(".activity-row");
  if (!row || !row.dataset.memoryId) return;
  const memory = memories.find(m => m.id === row.dataset.memoryId);
  if (!memory) return;
  document.querySelector("#activity-sheet").close();
  openReplies(memory, row.dataset.actorId, row.dataset.actorName);
});

// ============================================================
// PEOPLE — search, invite, contacts (contacts remains honest-stub)
// ============================================================
const addPeopleDialog = document.querySelector("#add-people");
function openPeopleStep(step) { setPeopleStep(step); addPeopleDialog.showModal(); }
function setPeopleStep(step) { document.querySelectorAll(".people-step").forEach(el => el.classList.toggle("active", el.dataset.peopleStep === step)); }
document.querySelector("#prompt-add-person").addEventListener("click", () => openPeopleStep("choices"));
document.querySelector("#close-add-people").addEventListener("click", () => addPeopleDialog.close());
document.querySelectorAll(".people-back").forEach(button => button.addEventListener("click", () => setPeopleStep("choices")));
document.querySelectorAll(".setup-choice[data-choice]").forEach(button => button.addEventListener("click", () => { if (!addPeopleDialog.open) addPeopleDialog.showModal(); setPeopleStep(button.dataset.choice); }));

document.querySelector("#search-input").addEventListener("input", async () => {
  const query = document.querySelector("#search-input").value.trim();
  const results = document.querySelector("#search-results");
  if (!query) { results.innerHTML = ""; return; }
  const matches = await searchProfiles(query);
  const alreadyKnown = new Set([...connections.map(c => otherPerson(c).id), ...pendingRequests.map(r => r.requester.id), currentUser.id]);
  const filtered = matches.filter(person => !alreadyKnown.has(person.id));
  results.innerHTML = filtered.length === 0
    ? `<div class="search-empty"><p>No one found with that name or username.</p><button class="text-button" type="button" data-people-step-target="invite">Invite them instead</button></div>`
    : filtered.map(person => `<div class="person-row"><div class="avatar">${initialsOf(person.name)}</div><div><b>${escapeHTML(person.name)}</b>${person.username ? `<span>@${escapeHTML(person.username)}</span>` : ""}</div><button class="row-add" data-add-search="${person.id}">Add</button></div>`).join("");
});
document.querySelector("#search-results").addEventListener("click", async event => {
  const addButton = event.target.closest("[data-add-search]");
  if (addButton) { await sendConnectionRequest(addButton.dataset.addSearch); addPeopleDialog.close(); return; }
  const inviteButton = event.target.closest('[data-people-step-target="invite"]');
  if (inviteButton) setPeopleStep("invite");
});

document.querySelectorAll('.setup-choice[data-choice="invite"]').forEach(button => button.addEventListener("click", refreshInviteLink));
async function refreshInviteLink() {
  const { token } = await createInvite();
  const link = `${window.location.origin}${window.location.pathname}?invite=${token}`;
  document.querySelector("#invite-link").textContent = link;
  document.querySelector("#invite-link").dataset.link = link;
}
document.querySelector("#copy-invite").addEventListener("click", () => {
  navigator.clipboard.writeText(document.querySelector("#invite-link").dataset.link || document.querySelector("#invite-link").textContent);
  const copyButton = document.querySelector("#copy-invite");
  copyButton.textContent = "Copied"; setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
});
document.querySelector("#send-invite").addEventListener("click", () => addPeopleDialog.close());

document.querySelector("#allow-contacts").addEventListener("click", () => { document.querySelector("#contacts-result").classList.remove("hidden"); });
document.querySelector("#contacts-to-invite").addEventListener("click", () => setPeopleStep("invite"));

// ============================================================
// SETTINGS — profile, circles, account
// ============================================================
document.querySelector("#settings-button").addEventListener("click", () => { renderSettingsCircles(); document.querySelector("#settings-sheet").showModal(); });
document.querySelector("#close-settings").addEventListener("click", () => document.querySelector("#settings-sheet").close());

function renderSettingsCircles() {
  document.querySelector("#settings-circles-list").innerHTML = circles.map(circle => {
    if (circle.id === null) return `<div class="setting-row circle-row"><i data-lucide="users-round"></i><span>${circle.name}</span></div>`;
    const memberCount = (circle.circle_members || []).length;
    return `<button type="button" class="setting-row circle-row" data-circle-id="${circle.id}"><i data-lucide="users-round"></i><span>${escapeHTML(circle.name)}</span><span class="setting-value">${memberCount || ""}</span><i class="chevron" data-lucide="chevron-right"></i></button>`;
  }).join("");
  if (window.lucide) window.lucide.createIcons();
}
document.querySelector("#settings-circles-list").addEventListener("click", event => {
  const row = event.target.closest(".circle-row[data-circle-id]");
  if (row) openCircleMembers(row.dataset.circleId);
});
let editingCircleId = null;
function openCircleMembers(circleId) {
  editingCircleId = circleId;
  const circle = circles.find(c => c.id === circleId);
  document.querySelector("#circle-members-title").textContent = circle.name;
  renderCircleMembers();
  document.querySelector("#settings-sheet").close();
  document.querySelector("#circle-members-sheet").showModal();
}
function renderCircleMembers() {
  const circle = circles.find(c => c.id === editingCircleId);
  const memberIds = new Set((circle.circle_members || []).map(m => m.person_id));
  const list = document.querySelector("#circle-members-list");
  if (connections.length === 0) { list.innerHTML = emptyState({ icon:"users-round", title:"No one to add yet", text:"Add people first, then come back to build this circle." }); return; }
  list.innerHTML = connections.map(connection => { const person = otherPerson(connection); return `<div class="setting-row circle-member-row"><div class="avatar">${initialsOf(person.name)}</div><span>${escapeHTML(person.name)}</span><label class="switch"><input type="checkbox" data-member-id="${person.id}" ${memberIds.has(person.id) ? "checked" : ""}><span class="switch-track"></span></label></div>`; }).join("");
}
document.querySelector("#circle-members-list").addEventListener("change", async event => {
  const checkbox = event.target.closest("input[data-member-id]");
  if (!checkbox) return;
  const circle = circles.find(c => c.id === editingCircleId);
  if (checkbox.checked) { await addCircleMember(editingCircleId, checkbox.dataset.memberId); circle.circle_members.push({ person_id: checkbox.dataset.memberId }); }
  else { await removeCircleMember(editingCircleId, checkbox.dataset.memberId); circle.circle_members = circle.circle_members.filter(m => m.person_id !== checkbox.dataset.memberId); }
});
document.querySelector("#close-circle-members").addEventListener("click", () => { document.querySelector("#circle-members-sheet").close(); renderSettingsCircles(); document.querySelector("#settings-sheet").showModal(); });
document.querySelector("#delete-circle-button").addEventListener("click", async () => {
  await deleteCircle(editingCircleId);
  circles = circles.filter(c => c.id !== editingCircleId);
  document.querySelector("#circle-members-sheet").close();
  renderSettingsCircles();
  document.querySelector("#settings-sheet").showModal();
});

document.querySelector("#settings-edit-profile").addEventListener("click", () => {
  document.querySelector("#edit-profile-name").value = currentUser.name;
  document.querySelector("#edit-profile-bio").value = currentUser.bio || "";
  document.querySelector("#settings-sheet").close();
  document.querySelector("#edit-profile-sheet").showModal();
});
document.querySelector("#cancel-edit-profile").addEventListener("click", () => { document.querySelector("#edit-profile-sheet").close(); document.querySelector("#settings-sheet").showModal(); });
document.querySelector("#save-edit-profile").addEventListener("click", async () => {
  const nameInput = document.querySelector("#edit-profile-name");
  const name = nameInput.value.trim();
  if (!name) { document.querySelector("#edit-profile-name-hint").classList.remove("hidden"); nameInput.classList.add("error"); nameInput.focus(); return; }
  document.querySelector("#edit-profile-name-hint").classList.add("hidden"); nameInput.classList.remove("error");
  const bio = document.querySelector("#edit-profile-bio").value.trim();
  currentUser = await updateProfile({ name, bio });
  document.querySelector(".profile h2").textContent = currentUser.name;
  document.querySelector("#avatar-initials").textContent = initialsOf(currentUser.name);
  const bioEl = document.querySelector(".profile p");
  if (bio) { bioEl.textContent = bio; bioEl.classList.remove("placeholder"); } else { bioEl.textContent = "No bio yet"; bioEl.classList.add("placeholder"); }
  document.querySelector("#edit-profile-sheet").close();
  document.querySelector("#settings-sheet").showModal();
});
document.querySelector("#settings-change-photo").addEventListener("click", () => document.querySelector("#avatar-input").click());
document.querySelector("#avatar-button").addEventListener("click", () => document.querySelector("#avatar-input").click());
document.querySelector("#avatar-input").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  const url = await uploadAvatar(file);
  const avatarButton = document.querySelector("#avatar-button");
  avatarButton.style.backgroundImage = `url(${url})`;
  avatarButton.classList.add("has-photo");
});

document.querySelector("#settings-who-can-request").addEventListener("click", () => document.querySelector("#request-privacy-sheet").showModal());
document.querySelector("#cancel-request-privacy").addEventListener("click", () => document.querySelector("#request-privacy-sheet").close());
document.querySelector("#request-privacy-sheet").addEventListener("click", event => {
  const choice = event.target.closest("[data-privacy]");
  if (!choice) return;
  document.querySelector("#request-privacy-value").textContent = choice.dataset.privacy;
  document.querySelector("#request-privacy-sheet").close();
});

function resetToWelcome() {
  currentUser = null; circles = []; connections = []; pendingRequests = []; memories = []; activity = [];
  const avatarButton = document.querySelector("#avatar-button");
  avatarButton.classList.remove("has-photo"); avatarButton.style.backgroundImage = "";
  document.querySelector("#avatar-initials").textContent = "Y";
  document.querySelector(".profile h2").textContent = "You";
  const bioEl = document.querySelector(".profile p"); bioEl.textContent = "No bio yet"; bioEl.classList.add("placeholder");
  updateActivityBadge();
  document.querySelector("#onboarding").classList.remove("hidden");
  showOnboardingStep(0);
  document.querySelector('.tab[data-screen="home-screen"]').click();
}
document.querySelector("#settings-sign-out").addEventListener("click", async () => { document.querySelector("#settings-sheet").close(); await signOut(); resetToWelcome(); });
document.querySelector("#settings-delete-account").addEventListener("click", () => document.querySelector("#delete-account-confirm").showModal());
document.querySelector("#cancel-delete-account").addEventListener("click", () => document.querySelector("#delete-account-confirm").close());
document.querySelector("#confirm-delete-account").addEventListener("click", async () => {
  await deleteMyAccount();
  document.querySelector("#delete-account-confirm").close();
  document.querySelector("#settings-sheet").close();
  resetToWelcome();
});

document.querySelectorAll("[data-next]").forEach(button => button.addEventListener("click", () => showOnboardingStep(button.dataset.next)));
document.querySelector("#finish-onboarding").addEventListener("click", () => document.querySelector("#onboarding").classList.add("hidden"));

if (window.lucide) window.lucide.createIcons();
