import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";

dotenv.config();

const app = express();
app.use(express.json());
// LiveKit sends webhooks as raw binary/text, but often we want the JSON
app.use(express.raw({ type: 'application/webhook+json' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

const LIVEKIT_URL = process.env.LIVEKIT_URL; 
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

app.post("/api/voice-token", async (req, res) => {
  console.log(".........Token API Called.")
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({ 
        error: "Backend misconfiguration: Missing LiveKit Keys or Secret in .env" 
      });
    }

    const participantIdentity = "web-user-" + Math.floor(Math.random() * 10000);
    const roomName = "production-voice-room";

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: "Web Caller",
      ttl: "15m",
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    });

    const tokenStr = await at.toJwt();
    console.log(`✅ Cryptographic token generated successfully for ${participantIdentity}`);

    res.json({
      rtc_url: LIVEKIT_URL, 
      token: tokenStr,
    });

  } catch (err) {
    console.error("💥 Token generation crashed:", err.message);
    res.status(500).json({ error: "Failed to build access token", detail: err.message });
  }
});

app.post("/api/generate-summary", async (req, res) => {
  const { transcript, actions, duration } = req.body;
  console.log("📝 Generating post-call summary...");

  // Formulate a beautiful summary
  const summaryTitle = "Interaction Summary";
  const dateStr = new Date().toLocaleString();
  
  let formattedActions = "";
  if (actions && actions.length > 0) {
    formattedActions = actions.map(act => {
      if (act.action === "open_url") {
        return `- 🔗 Opened runbook URL: [${act.payload?.url}](${act.payload?.url})`;
      } else if (act.action === "request_confirm") {
        return `- ⚠️ Requested user confirmation for: "${act.payload?.prompt}" (Response: ${act.ok ? "Approved ✓" : "Declined ✗"})`;
      }
      return `- Tool executed: ${act.action}`;
    }).join("\n");
  } else {
    formattedActions = "*No automated actions were triggered during this session.*";
  }

  let formattedTranscript = "";
  if (transcript && transcript.length > 0) {
    formattedTranscript = transcript.map(t => `**[${t.sender}]**: ${t.text}`).join("\n\n");
  } else {
    formattedTranscript = "*No conversation was recorded.*";
  }

  // Basic SRE summary generation
  let incidentOverview = "The engineer initiated a voice support call to troubleshoot a system issue. The conversation details indicate ";
  if (transcript && transcript.length > 0) {
    const textAll = transcript.map(t => t.text).join(" ").toLowerCase();
    if (textAll.includes("database") || textAll.includes("db")) {
      incidentOverview += "a potential database performance bottleneck or connection pool exhaustion.";
    } else if (textAll.includes("latency") || textAll.includes("slow")) {
      incidentOverview += "an elevated API response latency affecting upstream microservices.";
    } else if (textAll.includes("restart") || textAll.includes("reboot")) {
      incidentOverview += "a manual service container restart operation requested for triage.";
    } else {
      incidentOverview += "general server health checks and routine runbook reviews.";
    }
  } else {
    incidentOverview += "no issues were raised during this connection.";
  }

  const markdownReport = `
# 🛠️ ${summaryTitle}

**Date/Time:** ${dateStr}  
**Call Duration:** ${duration || "0"} seconds  
**Status:** Closed / Resolved  

## 📋 Executive Overview
${incidentOverview}

## ⚡ Actions Taken (AI tools)
${formattedActions}

## 💬 Conversation Transcript
${formattedTranscript}
  `.trim();

  res.json({
    title: summaryTitle,
    date: dateStr,
    duration: duration,
    summary: markdownReport
  });
});

app.post("/webhooks/livekit", async (req, res) => {
  try {
    const event = await receiver.receive(req.body, req.get("Authorization"));
    console.log(`[Webhook] Received event: ${event.event}`, event.room?.name);

    if (event.event === "room_finished") {
      console.log("--- Post-Call Processing Started ---");
      console.log(`Room ${event.room?.name} ended. Triggering summarization...`);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook validation failed:", err.message);
    res.status(401).send("Unauthorized");
  }
});

app.listen(3000, () => console.log("🚀 Server running at http://localhost:3000"));