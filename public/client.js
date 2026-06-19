import { Room, RoomEvent, Track } from "https://cdnjs.cloudflare.com/ajax/libs/livekit-client/2.15.7/livekit-client.esm.mjs";

const startBtn = document.getElementById("startBtn");
const endBtn = document.getElementById("endBtn");
const statusEl = document.getElementById("statusText");
const statusIndicator = document.getElementById("statusIndicator");
const visualizerWrapper = document.getElementById("visualizerWrapper");

const chatBox = document.getElementById("chatBox");
const actionsLog = document.getElementById("actionsLog");

let room = null;
let intentionallyDisconnected = false;
let audioEls = [];

let callStartTime = null;
let sessionTranscript = [];
let sessionActions = [];

const ALLOWED_ACTIONS = new Set(["open_url", "request_confirm"]);
const EXECUTED_ACTION_IDS = new Set();
const ALLOWED_HOSTS = new Set([window.location.host, "www.google.com"]); 

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  
  statusIndicator.className = "status-indicator";
  if (state === "connected") {
    statusIndicator.classList.add("connected");
  } else if (state === "connecting") {
    statusIndicator.classList.add("connecting");
  }
  
  console.log(`[Status] ${text}`);
}

function setVisualizerState(state) {
  visualizerWrapper.className = "visualizer-wrapper";
  if (state === "speaking") {
    visualizerWrapper.classList.add("speaking");
  } else if (state === "thinking") {
    visualizerWrapper.classList.add("thinking");
  }
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

function parseClientAction(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  
  if (msg?.type !== "client_action") return null;
  if (typeof msg.id !== "string") return null;
  if (!ALLOWED_ACTIONS.has(msg.action)) return null;
  return msg;
}

async function handleClientAction(msg, room) {
  if (EXECUTED_ACTION_IDS.has(msg.id)) return;
  EXECUTED_ACTION_IDS.add(msg.id);

  if (msg.action === "open_url") {
    const url = msg.payload?.url;
    try {
      const u = new URL(url);
      if (!ALLOWED_HOSTS.has(u.host)) {
        console.warn(`Blocked navigation to untrusted host: ${u.host}`);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      logAction("open_url", url, true);
    } catch (e) {
      console.error("Invalid URL in client action", e);
    }
  }

  if (msg.action === "request_confirm") {
    // Show immersive custom modal
    const modal = document.getElementById("confirmModal");
    const promptEl = document.getElementById("confirmPrompt");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    promptEl.textContent = msg.payload?.prompt || "Confirm action?";
    modal.classList.add("show");

    // Asynchronously wait for user choice
    const approved = await new Promise((resolve) => {
      const handleOk = () => {
        cleanup();
        resolve(true);
      };
      const handleCancel = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        okBtn.removeEventListener("click", handleOk);
        cancelBtn.removeEventListener("click", handleCancel);
        modal.classList.remove("show");
      };

      okBtn.addEventListener("click", handleOk);
      cancelBtn.addEventListener("click", handleCancel);
    });

    // Send decision back to the agent
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "user_confirmed", id: msg.id, ok: approved })),
      { topic: "client_events", reliable: true }
    );

    logAction("request_confirm", msg.payload?.prompt, approved);
  }
}

function addChatBubble(sender, text, isFinal = true, bubbleId = null) {
  const placeholder = document.getElementById("chatPlaceholder");
  if (placeholder) {
    placeholder.remove();
  }

  let bubble = null;
  if (bubbleId) {
    bubble = document.getElementById(bubbleId);
  }

  if (!bubble) {
    bubble = document.createElement("div");
    if (bubbleId) bubble.id = bubbleId;
    bubble.className = `chat-bubble ${sender.toLowerCase() === "sre" ? "user" : "agent"}`;
    
    const senderEl = document.createElement("div");
    senderEl.className = "chat-sender";
    senderEl.textContent = sender;
    bubble.appendChild(senderEl);

    const textEl = document.createElement("span");
    textEl.className = "chat-text";
    bubble.appendChild(textEl);

    const timeEl = document.createElement("div");
    timeEl.className = "chat-time";
    timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    bubble.appendChild(timeEl);

    chatBox.appendChild(bubble);
  }

  const textEl = bubble.querySelector(".chat-text");
  textEl.textContent = text;

  // Track in transcript array for post-mortem generation if it's final
  if (isFinal) {
    // Replace old entry if it exists, otherwise add new one
    const idx = sessionTranscript.findIndex(item => item.id === bubbleId);
    if (idx !== -1) {
      sessionTranscript[idx].text = text;
    } else {
      sessionTranscript.push({ id: bubbleId, sender, text });
    }
  }

  chatBox.scrollTop = chatBox.scrollHeight;
}

function logAction(type, detail, result = null) {
  const placeholder = document.getElementById("actionsPlaceholder");
  if (placeholder) {
    placeholder.remove();
  }

  const entry = document.createElement("div");
  entry.className = "action-entry success";

  const badge = document.createElement("span");
  badge.className = `action-badge ${type}`;
  badge.textContent = type === "open_url" ? "open runbook" : "confirm action";
  entry.appendChild(badge);

  const text = document.createElement("span");
  text.className = "action-details";
  if (type === "open_url") {
    text.innerHTML = `Opened runbook: <a href="${detail}" target="_blank" style="color: var(--accent-blue); text-decoration: underline;">${detail}</a>`;
  } else if (type === "request_confirm") {
    const statusText = result === true ? "Approved ✓" : "Declined ✗";
    text.textContent = `Requested confirm for: "${detail}" (${statusText})`;
  }
  entry.appendChild(text);

  const time = document.createElement("span");
  time.className = "action-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  entry.appendChild(time);

  actionsLog.appendChild(entry);
  actionsLog.scrollTop = actionsLog.scrollHeight;

  sessionActions.push({
    action: type,
    payload: type === "open_url" ? { url: detail } : { prompt: detail },
    ok: result
  });
}

function wireRoomEvents(r) {
  // 1) Play the agent audio track when subscribed
  r.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;

    const el = track.attach();
    audioEls.push(el);
    document.body.appendChild(el);

    el.play?.().catch(() => {
      setStatus("Connected (click page to play audio)", "connected");
    });
  });

  // 2) Reconnect on disconnect
  r.on(RoomEvent.Disconnected, async () => {
    if (intentionallyDisconnected) return;
    setStatus("Disconnected (reconnecting...)", "connecting");
    await attemptReconnect();
  });

  // 3) Handle Data Channel (Client Actions and Agent State)
  r.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
    const text = new TextDecoder().decode(payload);
    
    // Handle Client Actions
    if (topic === "client_actions") {
      const msg = parseClientAction(text);
      if (msg) handleClientAction(msg, r);
      return;
    }

    // Handle Agent State updates (Observability)
    try {
      const msg = JSON.parse(text);
      if (msg.type === "agent_state") {
        setStatus(`Agent is ${msg.state}...`, "connected");
        setVisualizerState(msg.state); // speaking, thinking, idle
      }
    } catch {}
  });

  // 4) Register real-time text stream handler for transcriptions
  r.registerTextStreamHandler("lk.transcription", async (reader, participantInfo) => {
    const isLocal = participantInfo.identity === r.localParticipant.identity || participantInfo.identity.startsWith("web-user");
    const senderName = isLocal ? "SRE" : "SRE Agent";
    const bubbleId = "bubble_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    
    if (!isLocal) {
      setVisualizerState("speaking");
    }

    let text = "";
    try {
      for await (const chunk of reader) {
        text += chunk;
      }
      addChatBubble(senderName, text, true, bubbleId);
    } catch (err) {
      console.error("Error reading text stream:", err);
    } finally {
      if (!isLocal) {
        setVisualizerState("idle");
      }
    }
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
  setStatus("Connecting...", "connecting");
  setVisualizerState("thinking");

  try {
    room = await connectOnce();
    setStatus("Connected", "connected");
    setVisualizerState("idle");
    startBtn.disabled = true;
    endBtn.disabled = false;
    
    // Reset session trackers
    callStartTime = Date.now();
    sessionTranscript = [];
    sessionActions = [];
    EXECUTED_ACTION_IDS.clear();
    
    // Clear logs
    chatBox.innerHTML = '<div class="chat-placeholder" id="chatPlaceholder">Awaiting transcription...</div>';
    actionsLog.innerHTML = '<div class="chat-placeholder" id="actionsPlaceholder">Awaiting tools execution...</div>';

  } catch (err) {
    setStatus(err?.message || "Connection failed");
    setVisualizerState("idle");
    throw err;
  }
}

async function stopCall() {
  intentionallyDisconnected = true;
  const durationSeconds = callStartTime ? Math.round((Date.now() - callStartTime) / 1000) : 0;

  try {
    await room?.localParticipant?.setMicrophoneEnabled(false);
  } catch {}

  try {
    room?.disconnect();
  } catch {}

  room = null;
  detachAllAudio();

  setStatus("Disconnected");
  setVisualizerState("idle");
  startBtn.disabled = false;
  endBtn.disabled = true;

  // Show summary report
  showPostCallSummary(durationSeconds);
}

async function attemptReconnect() {
  const delaysMs = [250, 500, 1000, 2000];

  for (const delay of delaysMs) {
    if (intentionallyDisconnected) return;

    try {
      try { room?.disconnect(); } catch {}
      room = null;
      detachAllAudio();

      await new Promise((r) => setTimeout(r, delay));

      room = await connectOnce();
      setStatus("Reconnected", "connected");
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

async function showPostCallSummary(duration) {
  const overlay = document.getElementById("summaryOverlay");
  const contentEl = document.getElementById("summaryContent");
  overlay.classList.add("show");
  contentEl.innerHTML = "<p>Generating post-call incident summary report...</p>";

  try {
    const response = await fetch("/api/generate-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: sessionTranscript,
        actions: sessionActions,
        duration: duration
      })
    });

    if (!response.ok) {
      throw new Error(`Summary generation failed: ${response.status}`);
    }

    const report = await response.json();
    
    // Parse simple markdown headers and lists for premium rendering
    let htmlContent = report.summary
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^\*\*([^*]+)\*\*:(.*$)/gim, '<strong>$1</strong>:$2')
      .replace(/^\* (.*$)/gim, '<ul><li>$1</li></ul>')
      .replace(/^- (.*$)/gim, '<ul><li>$1</li></ul>')
      .replace(/\n\n/g, '<br/>')
      .replace(/<\/ul><br\/><ul>/g, ''); // consolidate lists

    contentEl.innerHTML = htmlContent;
  } catch (err) {
    contentEl.innerHTML = `<p style="color: var(--accent-rose);">Error generating report: ${err.message}</p>`;
  }
}

// Hook up simulation buttons
const speakButtons = document.querySelectorAll(".btn-sim");
speakButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const textToSpeak = btn.getAttribute("data-speak");
    if (!textToSpeak) return;

    if ('speechSynthesis' in window) {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Speaking...";

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      utterance.pitch = 1;
      utterance.rate = 0.95;

      utterance.onend = () => {
        btn.disabled = false;
        btn.textContent = originalText;
      };
      utterance.onerror = () => {
        btn.disabled = false;
        btn.textContent = originalText;
      };

      window.speechSynthesis.speak(utterance);
    } else {
      alert("Your browser does not support text-to-speech. Please speak directly into the microphone.");
    }
  });
});

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

document.getElementById("closeSummaryBtn").addEventListener("click", () => {
  document.getElementById("summaryOverlay").classList.remove("show");
});