import { Room, RoomEvent, Track } from "https://cdnjs.cloudflare.com/ajax/libs/livekit-client/2.15.7/livekit-client.esm.mjs";

const startBtn = document.getElementById("startBtn");
const endBtn = document.getElementById("endBtn");
const statusEl = document.getElementById("statusText");
const statusIndicator = document.getElementById("statusIndicator");
const visualizerWrapper = document.getElementById("visualizerWrapper");

const chatBox = document.getElementById("chatBox");


let room = null;
let activeConversationId = null;
let intentionallyDisconnected = false;
let audioEls = [];

let sessionTranscript = [];

const ALLOWED_ACTIONS = new Set(["open_url", "request_confirm", "end_call"]);
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
  const repositoryUrls = activeRepositoryUrl
    ? activeRepositoryUrl.split(",").map(url => url.trim()).filter(Boolean)
    : [];
  const payload = {
    operatorName: activeOperatorName,
    repositoryUrl: repositoryUrls[0] || "",
    repositoryUrls: repositoryUrls
  };
  if (activeConversationId) {
    payload.conversationId = activeConversationId;
  }
  
  const res = await fetch("/api/voice-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token request failed: ${detail || res.status}`);
  }

  const { rtc_url, token, conversationId } = await res.json();
  if (!rtc_url || !token) throw new Error("Token response missing rtc_url or token");
  return { rtc_url, token, conversationId };
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


  }

  if (msg.action === "end_call") {
    console.log("Agent requested to end the call.");
    stopCall();
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

    if (activeConversationId) {
      fetch(`/api/conversations/${activeConversationId}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, text })
      }).catch(err => console.error("Failed to persist transcript segment:", err));
    }
  }

  chatBox.scrollTop = chatBox.scrollHeight;
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
    
    // Handle DevOps Generated message
    if (topic === "devops_artifacts_generated") {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "devops_artifacts_generated") {
          handleDevopsGenerated(msg.files);
        }
      } catch (err) {
        console.error("Error parsing devops artifacts:", err);
      }
      return;
    }
    
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
    const attributes = reader.info?.attributes || {};
    const bubbleId = attributes['lk.segment_id'] || reader.info?.id || "bubble_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    
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

async function cleanRoom(r) {
  if (!r) return;
  console.log("[cleanRoom] Cleaning up room and stopping all tracks");

  // 1. Explicitly disable microphone (unpublishes it and signals state to server)
  try {
    if (r.localParticipant) {
      console.log("[cleanRoom] Disabling microphone on local participant");
      await r.localParticipant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    console.error("[cleanRoom] Error calling setMicrophoneEnabled(false):", err);
  }

  // 2. Iterate and stop all tracks (audio & video, publication & direct)
  try {
    if (r.localParticipant) {
      const tracksToStop = new Set();
      
      // Check trackPublications
      if (r.localParticipant.trackPublications) {
        for (const pub of r.localParticipant.trackPublications.values()) {
          if (pub.track) tracksToStop.add(pub.track);
        }
      }
      
      // Check audioTrackPublications
      if (r.localParticipant.audioTrackPublications) {
        for (const pub of r.localParticipant.audioTrackPublications.values()) {
          if (pub.track) tracksToStop.add(pub.track);
        }
      }
      
      // Check videoTrackPublications
      if (r.localParticipant.videoTrackPublications) {
        for (const pub of r.localParticipant.videoTrackPublications.values()) {
          if (pub.track) tracksToStop.add(pub.track);
        }
      }

      for (const track of tracksToStop) {
        console.log("[cleanRoom] Stopping track:", track.sid || track.name);
        try {
          track.stop();
        } catch (e) {
          console.error("[cleanRoom] Failed to stop track.stop():", e);
        }
        try {
          track.mediaStreamTrack?.stop();
        } catch (e) {
          console.error("[cleanRoom] Failed to stop track.mediaStreamTrack.stop():", e);
        }
      }
    }
  } catch (err) {
    console.error("[cleanRoom] Error in track stopping loop:", err);
  }

  // 3. Disconnect from room
  try {
    console.log("[cleanRoom] Disconnecting room");
    r.disconnect();
  } catch (err) {
    console.error("[cleanRoom] Error calling room.disconnect():", err);
  }
}

async function connectOnce() {
  const { rtc_url, token, conversationId } = await mintToken();
  activeConversationId = conversationId;
  const r = new Room();
  wireRoomEvents(r);

  try {
    await r.connect(rtc_url, token);

    // Mic permission + publish mic
    await r.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    console.error("Error during connectOnce:", err);
    await cleanRoom(r);
    if (err?.name === "NotAllowedError" || err?.message?.toLowerCase().includes("permission")) {
      throw new Error("Microphone access denied. Allow mic permission and try again.");
    }
    throw err;
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
    sessionTranscript = [];
    EXECUTED_ACTION_IDS.clear();
    
    // Clear logs
    chatBox.innerHTML = '<div class="chat-placeholder" id="chatPlaceholder">Awaiting transcription...</div>';

  } catch (err) {
    setStatus(err?.message || "Connection failed");
    setVisualizerState("idle");
    if (room) {
      await cleanRoom(room);
      room = null;
    }
    detachAllAudio();
    throw err;
  }
}

async function stopCall() {
  intentionallyDisconnected = true;

  if (room) {
    await cleanRoom(room);
    room = null;
  }
  detachAllAudio();

  setStatus("Disconnected");
  setVisualizerState("idle");
  startBtn.disabled = false;
  endBtn.disabled = true;
}

async function attemptReconnect() {
  const delaysMs = [250, 500, 1000, 2000];

  for (const delay of delaysMs) {
    if (intentionallyDisconnected) return;

    try {
      if (room) {
        await cleanRoom(room);
        room = null;
      }
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

  if (room) {
    await cleanRoom(room);
    room = null;
  }
  setStatus("Disconnected (reconnect failed)");
  startBtn.disabled = false;
  endBtn.disabled = true;
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
  activeConversationId = null;
  try {
    await startCall();
  } catch (err) {
    setStatus(err?.message || "Connection failed");
    startBtn.disabled = false;
    endBtn.disabled = true;
    if (room) {
      await cleanRoom(room);
      room = null;
    }
    detachAllAudio();
  }
});

endBtn.addEventListener("click", async () => {
  await stopCall();
});



// Manual Chat/Paste Text Message Submission Handler
const sendChatBtn = document.getElementById("sendChatBtn");
const chatInput = document.getElementById("chatInput");

async function submitTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  if (room && room.state === "connected") {
    try {
      const payload = JSON.stringify({ type: "chat_message", text: text });
      await room.localParticipant.publishData(
        new TextEncoder().encode(payload),
        { topic: "client_events", reliable: true }
      );
      addChatBubble("SRE", text, true, "msg_" + Date.now());
      chatInput.value = "";
    } catch (err) {
      console.error("Failed to publish text message:", err);
      alert("Error sending message to the agent.");
    }
  } else {
    alert("Please start the call first to connect with the SRE Agent.");
  }
}

sendChatBtn.addEventListener("click", submitTextMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitTextMessage();
  }
});

// SRE Identity Operator Handling
const operatorInput = document.getElementById("sreOperatorInput");
let activeOperatorName = localStorage.getItem("sre_operator") || "sre_operator";
operatorInput.value = activeOperatorName;
operatorInput.addEventListener("input", (e) => {
  activeOperatorName = e.target.value.trim() || "sre_operator";
  localStorage.setItem("sre_operator", activeOperatorName);
});

// SRE Linked Repository Handling
const repositoryInput = document.getElementById("sreRepositoryInput");
let activeRepositoryUrl = localStorage.getItem("sre_repository") || "";
repositoryInput.value = activeRepositoryUrl;
repositoryInput.addEventListener("input", (e) => {
  activeRepositoryUrl = e.target.value.trim();
  localStorage.setItem("sre_repository", activeRepositoryUrl);
});

// SRE History Hub Initialization
loadHistoryList();

// History Hub Tab switching
let currentHistoryTab = "conversations";
const tabConversations = document.getElementById("tabConversations");
const tabArtifacts = document.getElementById("tabArtifacts");

tabConversations.addEventListener("click", () => {
  tabConversations.classList.add("active");
  tabConversations.style.background = "rgba(255, 255, 255, 0.05)";
  tabConversations.style.color = "var(--text-primary)";
  
  tabArtifacts.classList.remove("active");
  tabArtifacts.style.background = "transparent";
  tabArtifacts.style.color = "var(--text-secondary)";
  
  currentHistoryTab = "conversations";
  loadHistoryList();
});

tabArtifacts.addEventListener("click", () => {
  tabArtifacts.classList.add("active");
  tabArtifacts.style.background = "rgba(255, 255, 255, 0.05)";
  tabArtifacts.style.color = "var(--text-primary)";
  
  tabConversations.classList.remove("active");
  tabConversations.style.background = "transparent";
  tabConversations.style.color = "var(--text-secondary)";
  
  currentHistoryTab = "artifacts";
  loadHistoryList();
});

// Database Fetch SRE listings
async function loadHistoryList() {
  const listContent = document.getElementById("historyListContent");
  listContent.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem; text-align: center; margin-top: 2rem;">Loading SRE logs...</div>';
  
  const serviceName = document.getElementById("filterServiceName").value.trim();
  const environment = document.getElementById("filterEnvironment").value.trim();
  const startDate = document.getElementById("filterStartDate").value;
  const endDate = document.getElementById("filterEndDate").value;
  
  const params = new URLSearchParams();
  if (serviceName) params.append("serviceName", serviceName);
  if (environment) params.append("environment", environment);
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);
  
  const endpoint = currentHistoryTab === "conversations" ? "/api/conversations" : "/api/artifacts";
  
  try {
    const res = await fetch(`${endpoint}?${params.toString()}`);
    if (!res.ok) throw new Error("API request failed");
    const items = await res.json();
    renderHistoryList(items, currentHistoryTab);
  } catch (err) {
    listContent.innerHTML = `<div style="color: var(--accent-rose); font-size: 0.85rem; text-align: center; margin-top: 2rem;">Error: ${err.message}</div>`;
  }
}

document.getElementById("searchHistoryBtn").addEventListener("click", loadHistoryList);

function renderHistoryList(items, type) {
  const listContent = document.getElementById("historyListContent");
  if (!items || items.length === 0) {
    listContent.innerHTML = `<div style="color: var(--text-secondary); font-size: 0.85rem; text-align: center; margin-top: 2rem;">No SRE ${type} found.</div>`;
    return;
  }
  
  listContent.innerHTML = "";
  
  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "sim-item";
    card.style.cursor = "pointer";
    card.style.background = "rgba(255,255,255,0.02)";
    card.style.padding = "0.8rem";
    card.style.borderRadius = "8px";
    card.style.transition = "transform 0.15s, background 0.15s";
    
    card.addEventListener("mouseenter", () => {
      card.style.transform = "translateX(4px)";
      card.style.background = "rgba(255,255,255,0.04)";
    });
    card.addEventListener("mouseleave", () => {
      card.style.transform = "none";
      card.style.background = "rgba(255,255,255,0.02)";
    });
    
    if (type === "conversations") {
      const dateStr = new Date(item.createdAt).toLocaleString();
      const repos = item.repositoryUrls && item.repositoryUrls.length > 0
        ? item.repositoryUrls
        : (item.repositoryUrl ? [item.repositoryUrl] : []);
        
      const repoSnippets = repos.map((url, i) => `
        <div style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-top: 0.15rem; font-size: 0.75rem;">
          🔗 Repo${repos.length > 1 ? ' ' + (i + 1) : ''}: <a href="${url}" target="_blank" style="color: var(--accent-blue); text-decoration: none; font-weight: 500;" onclick="event.stopPropagation();">${url}</a>
        </div>
      `).join('');
      
      card.innerHTML = `
        <div class="sim-row" style="font-weight: 600; font-size: 0.85rem;">
          <span style="color: var(--accent-blue);">💬 Session: ${item.id.substring(5, 12)}</span>
          <span style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">${item.triggerType}</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem;">
          <div>Service: <strong>${item.serviceName || "N/A"}</strong> | Env: <strong>${item.environment || "N/A"}</strong></div>
          ${repoSnippets}
          <div style="font-size: 0.7rem; margin-top: 0.2rem; color: #4b5563;">${dateStr}</div>
        </div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.6rem;">
          <button class="btn-sim resume-btn" data-id="${item.id}" style="padding: 0.3rem 0.6rem; font-size: 0.7rem; flex: 1; text-align: center; justify-content: center; font-weight: bold;">Resume Call</button>
          <button class="btn-sim view-chat-btn" style="padding: 0.3rem 0.6rem; font-size: 0.7rem; background: rgba(255,255,255,0.05); color: white; flex: 1; text-align: center; justify-content: center;">View Transcript</button>
        </div>
      `;
      
      card.querySelector(".resume-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        activeConversationId = item.id;
        try {
          await startCall();
        } catch (err) {
          alert("Resume Call failed: " + err.message);
        }
      });
      
      card.querySelector(".view-chat-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        displayConversationDetails(item);
      });
      
    } else {
      const dateStr = new Date(item.createdAt).toLocaleString();
      card.innerHTML = `
        <div class="sim-row" style="font-weight: 600; font-size: 0.85rem;">
          <span style="color: var(--accent-purple);">🛠️ ${item.name}</span>
          <span style="font-size: 0.7rem; color: var(--accent-emerald);">v${item.versions.length}</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem;">
          <div>Service: <strong>${item.serviceName || "N/A"}</strong> | Env: <strong>${item.environment || "N/A"}</strong></div>
          <div style="font-size: 0.7rem; margin-top: 0.2rem; color: #4b5563;">Modified: ${dateStr}</div>
        </div>
      `;
      
      card.addEventListener("click", () => {
        displayArtifactDetails(item);
      });
    }
    
    listContent.appendChild(card);
  });
}

// DevOps Generator Frontend Handling
let currentDevopsFiles = [];
let activeTabPath = "Dockerfile";
let activeViewingArtifact = null;

function handleDevopsGenerated(files) {
  const mockArtifact = {
    id: "art_" + Math.random().toString(36).substring(2, 9),
    name: "DevOps Pack",
    versions: [
      {
        version: 1,
        modifier: activeOperatorName,
        timestamp: Date.now(),
        files: files
      }
    ]
  };
  displayArtifactDetails(mockArtifact);
}

function displayArtifactDetails(artifact) {
  console.log("📂 Opening Artifact Details Viewer:", artifact);
  activeViewingArtifact = artifact;
  
  const selectEl = document.getElementById("artifactVersionSelect");
  selectEl.innerHTML = "";
  selectEl.style.display = "block";
  
  const sortedVersions = [...artifact.versions].reverse();
  sortedVersions.forEach(ver => {
    const dateStr = new Date(ver.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opt = document.createElement("option");
    opt.value = ver.version;
    opt.textContent = `v${ver.version} - ${ver.modifier} (${dateStr})`;
    selectEl.appendChild(opt);
  });
  
  const latestVersion = artifact.versions[artifact.versions.length - 1];
  currentDevopsFiles = latestVersion.files;
  
  const dockerfile = currentDevopsFiles.find(f => f.path.toLowerCase() === "dockerfile");
  activeTabPath = dockerfile ? dockerfile.path : (currentDevopsFiles[0]?.path || "");
  
  updateDevopsTabsUI();
  updateDevopsCodeUI();
  
  document.getElementById("devopsOverlay").classList.add("show");

}

document.getElementById("artifactVersionSelect").addEventListener("change", (e) => {
  if (!activeViewingArtifact) return;
  
  const selectedVersionNum = parseInt(e.target.value);
  const selectedVersion = activeViewingArtifact.versions.find(v => v.version === selectedVersionNum);
  
  if (selectedVersion) {
    currentDevopsFiles = selectedVersion.files;
    const dockerfile = currentDevopsFiles.find(f => f.path.toLowerCase() === "dockerfile");
    activeTabPath = dockerfile ? dockerfile.path : (currentDevopsFiles[0]?.path || "");
    
    updateDevopsTabsUI();
    updateDevopsCodeUI();
    console.log(`Loaded artifact version v${selectedVersionNum}`);
  }
});

function displayConversationDetails(conversation) {
  console.log("💬 Opening Conversation Details Viewer:", conversation);
  
  const lines = conversation.transcript.map(turn => `[${turn.sender}]: ${turn.text}`).join("\n\n");
  
  currentDevopsFiles = [
    {
      path: "Conversation_Transcript",
      content: lines || "No transcript turns captured for this conversation."
    }
  ];
  activeTabPath = "Conversation_Transcript";
  
  document.getElementById("artifactVersionSelect").style.display = "none";
  updateDevopsTabsUI();
  updateDevopsCodeUI();
  
  document.getElementById("devopsOverlay").classList.add("show");
}

function updateDevopsTabsUI() {
  const tabs = document.querySelectorAll(".devops-tab");
  tabs.forEach(tab => {
    const tabPath = tab.getAttribute("data-tab");
    
    const fileExists = currentDevopsFiles.some(f => f.path === tabPath || (tabPath === "Dockerfile" && f.path === "Conversation_Transcript"));
    if (fileExists) {
      tab.style.display = "block";
      if (tabPath === "Dockerfile" && currentDevopsFiles[0]?.path === "Conversation_Transcript") {
        tab.textContent = "Transcript";
      } else if (tabPath === "Dockerfile") {
        tab.textContent = "Dockerfile";
      }
    } else {
      tab.style.display = "none";
    }
    
    if (tabPath === activeTabPath || (tabPath === "Dockerfile" && activeTabPath === "Conversation_Transcript")) {
      tab.classList.add("active");
      tab.style.background = "rgba(255, 255, 255, 0.1)";
      tab.style.color = "var(--text-primary)";
      tab.style.borderBottom = "none";
    } else {
      tab.classList.remove("active");
      tab.style.background = "transparent";
      tab.style.color = "var(--text-secondary)";
    }
  });
}

function updateDevopsCodeUI() {
  const codeEl = document.getElementById("devopsCode");
  const file = currentDevopsFiles.find(f => f.path === activeTabPath);
  if (file) {
    codeEl.textContent = file.content;
  } else {
    codeEl.textContent = "No content available.";
  }
}



// Tab Switching Listeners
document.querySelectorAll(".devops-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    activeTabPath = tab.getAttribute("data-tab");
    if (activeTabPath === "Dockerfile" && currentDevopsFiles[0]?.path === "Conversation_Transcript") {
      activeTabPath = "Conversation_Transcript";
    }
    updateDevopsTabsUI();
    updateDevopsCodeUI();
  });
});

// Close drawer
document.getElementById("closeDevopsBtn").addEventListener("click", () => {
  document.getElementById("devopsOverlay").classList.remove("show");
});

// Download ZIP action
document.getElementById("downloadZipBtn").addEventListener("click", async () => {
  if (currentDevopsFiles.length === 0) return;
  
  try {
    const zip = new JSZip();
    currentDevopsFiles.forEach(file => {
      zip.file(file.path, file.content);
    });
    
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, "devops-config.zip");
  } catch (err) {
    alert("Failed to create ZIP: " + err.message);
  }
});

// Save to Workspace action
document.getElementById("saveWorkspaceBtn").addEventListener("click", async () => {
  if (currentDevopsFiles.length === 0) return;
  
  const saveBtn = document.getElementById("saveWorkspaceBtn");
  const originalText = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = "Saving...";
  
  try {
    const res = await fetch("/api/save-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: currentDevopsFiles })
    });
    
    const data = await res.json();
    if (res.ok && data.success) {
      alert("Success: " + data.message);
    } else {
      throw new Error(data.error || "Failed to save to workspace");
    }
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = originalText;
  }
});