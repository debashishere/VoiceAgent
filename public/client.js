import { Room, RoomEvent, Track } from "https://cdnjs.cloudflare.com/ajax/libs/livekit-client/2.15.7/livekit-client.esm.mjs";

const startBtn = document.getElementById("startBtn");
const endBtn = document.getElementById("endBtn");
const statusEl = document.getElementById("status");

let room = null;
let intentionallyDisconnected = false;
let audioEls = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function detachAllAudio() {
  for (const el of audioEls) {
    try { el.pause?.(); } catch {}
    el.remove();
  }
  audioEls = [];
}

async function mintToken() {
  const res = await fetch("/api/voice-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participant_name: "Web User" }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token request failed: ${detail || res.status}`);
  }

  const { rtc_url, token } = await res.json();
  if (!rtc_url || !token) throw new Error("Token response missing rtc_url or token");
  return { rtc_url, token };
}

function wireRoomEvents(r) {
  // 1) Play the agent audio track when subscribed
  r.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;

    const el = track.attach();
    audioEls.push(el);
    document.body.appendChild(el);

    // Autoplay restrictions vary by browser/device.
    el.play?.().catch(() => {
      setStatus("Connected (audio may be blocked — click the page to enable)");
    });
  });

  // 2) Reconnect on disconnect (token expiry often shows up this way)
  r.on(RoomEvent.Disconnected, async () => {
    if (intentionallyDisconnected) return;
    setStatus("Disconnected (reconnecting...)");
    await attemptReconnect();
  });
}

async function connectOnce() {
  const { rtc_url, token } = await mintToken();

  const r = new Room();
  wireRoomEvents(r);

  await r.connect(rtc_url, token);

  // Mic permission + publish mic
  try {
    await r.localParticipant.setMicrophoneEnabled(true);
  } catch {
    try { r.disconnect(); } catch {}
    throw new Error("Microphone access denied. Allow mic permission and try again.");
  }

  return r;
}

async function startCall() {
  if (room) return;

  intentionallyDisconnected = false;
  setStatus("Connecting...");

  room = await connectOnce();

  setStatus("Connected");
  startBtn.disabled = true;
  endBtn.disabled = false;
}

async function stopCall() {
  intentionallyDisconnected = true;

  try {
    await room?.localParticipant?.setMicrophoneEnabled(false);
  } catch {}

  try {
    room?.disconnect();
  } catch {}

  room = null;
  detachAllAudio();

  setStatus("Disconnected");
  startBtn.disabled = false;
  endBtn.disabled = true;
}

async function attemptReconnect() {
  // Simplified exponential backoff reconnect.
  // In production, add jitter, max attempts, and better error classification.
  const delaysMs = [250, 500, 1000, 2000];

  for (const delay of delaysMs) {
    if (intentionallyDisconnected) return;

    try {
      // Tear down current state before reconnecting
      try { room?.disconnect(); } catch {}
      room = null;
      detachAllAudio();

      await new Promise((r) => setTimeout(r, delay));

      room = await connectOnce();
      setStatus("Reconnected");
      startBtn.disabled = true;
      endBtn.disabled = false;
      return;
    } catch {
      // keep retrying
    }
  }

  setStatus("Disconnected (reconnect failed)");
  startBtn.disabled = false;
  endBtn.disabled = true;
}

startBtn.addEventListener("click", async () => {
  try {
    await startCall();
  } catch (err) {
    setStatus(err?.message || "Connection failed");
    startBtn.disabled = false;
    endBtn.disabled = true;
    room = null;
    detachAllAudio();
  }
});

endBtn.addEventListener("click", async () => {
  await stopCall();
});