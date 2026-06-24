import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
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

const CONVERSATIONS_DIR = path.join(__dirname, "data", "conversations");
const ARTIFACTS_DIR = path.join(__dirname, "data", "artifacts");
fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

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
    
    // Support resuming existing conversations or starting a new one
    const { conversationId, serviceName, environment, operatorName, repositoryUrl, repositoryUrls } = req.body;
    let convId = conversationId;
    
    if (!convId) {
      convId = "conv_" + Math.random().toString(36).substring(2, 11);
      
      // Auto create new conversation document
      const filePath = path.join(CONVERSATIONS_DIR, `${convId}.json`);
      const conversation = {
        id: convId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
        serviceName: serviceName || "",
        environment: environment || "",
        triggerType: "voice",
        repositoryUrl: repositoryUrl || "",
        repositoryUrls: repositoryUrls || [],
        transcript: [],
        artifacts: []
      };
      await fs.promises.writeFile(filePath, JSON.stringify(conversation, null, 2), "utf8");
      console.log(`Created new conversation context: ${convId}`);
    } else {
      // Validate that it exists
      const filePath = path.join(CONVERSATIONS_DIR, `${convId}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Conversation history context not found" });
      }
      console.log(`Resuming conversation context: ${convId}`);
    }

    const roomName = `room-${convId}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: operatorName || "Web Caller",
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
    console.log(`✅ Cryptographic token generated successfully for ${participantIdentity} (Room: ${roomName})`);

    res.json({
      rtc_url: LIVEKIT_URL, 
      token: tokenStr,
      conversationId: convId
    });

  } catch (err) {
    console.error("💥 Token generation crashed:", err.message);
    res.status(500).json({ error: "Failed to build access token", detail: err.message });
  }
});


app.post("/api/save-workspace", async (req, res) => {
  const { files } = req.body;
  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ error: "Invalid request body: files must be an array" });
  }

  const workspaceRoot = path.resolve(__dirname);

  try {
    for (const file of files) {
      if (!file.path || typeof file.content !== "string") {
        return res.status(400).json({ error: "Invalid file format: path and content are required" });
      }

      // Secure path validation against directory traversal
      const resolvedPath = path.resolve(workspaceRoot, file.path);
      if (!resolvedPath.startsWith(workspaceRoot)) {
        console.warn(`Blocked directory traversal attempt: ${file.path} (resolved: ${resolvedPath})`);
        return res.status(403).json({ error: "Access Denied: Path traversal detected" });
      }
    }

    // Write files if all paths are valid
    for (const file of files) {
      const resolvedPath = path.resolve(workspaceRoot, file.path);
      const dir = path.dirname(resolvedPath);
      
      // Ensure directory exists
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(resolvedPath, file.content, "utf8");
      console.log(`Successfully saved workspace file: ${file.path}`);
    }

    res.json({ success: true, message: "DevOps files saved successfully to workspace!" });
  } catch (err) {
    console.error("Error saving workspace files:", err);
    res.status(500).json({ error: "Failed to save files to workspace", detail: err.message });
  }
});

// Database API: Conversations
app.post("/api/conversations", async (req, res) => {
  try {
    const { id, serviceName, environment, triggerType, repositoryUrl, repositoryUrls } = req.body;
    const convId = id || "conv_" + Math.random().toString(36).substring(2, 11);
    const filePath = path.join(CONVERSATIONS_DIR, `${convId}.json`);
    
    const conversation = {
      id: convId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      serviceName: serviceName || "",
      environment: environment || "",
      triggerType: triggerType || "manual",
      repositoryUrl: repositoryUrl || "",
      repositoryUrls: repositoryUrls || [],
      transcript: [],
      artifacts: []
    };
    
    await fs.promises.writeFile(filePath, JSON.stringify(conversation, null, 2), "utf8");
    res.json(conversation);
  } catch (err) {
    console.error("POST /api/conversations error:", err);
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const files = await fs.promises.readdir(CONVERSATIONS_DIR);
    const conversations = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await fs.promises.readFile(path.join(CONVERSATIONS_DIR, file), "utf8");
        conversations.push(JSON.parse(content));
      }
    }
    conversations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    let filtered = conversations;
    const { serviceName, environment, date, startDate, endDate, triggerType } = req.query;
    if (serviceName) {
      filtered = filtered.filter(c => c.serviceName?.toLowerCase().includes(serviceName.toLowerCase()));
    }
    if (environment) {
      filtered = filtered.filter(c => c.environment?.toLowerCase() === environment.toLowerCase());
    }
    if (triggerType) {
      filtered = filtered.filter(c => c.triggerType?.toLowerCase() === triggerType.toLowerCase());
    }
    if (date) {
      filtered = filtered.filter(c => c.createdAt.startsWith(date));
    }
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      filtered = filtered.filter(c => new Date(c.createdAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filtered = filtered.filter(c => new Date(c.createdAt) <= end);
    }
    
    res.json(filtered);
  } catch (err) {
    console.error("GET /api/conversations error:", err);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(CONVERSATIONS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    const content = await fs.promises.readFile(filePath, "utf8");
    res.json(JSON.parse(content));
  } catch (err) {
    console.error("GET /api/conversations/:id error:", err);
    res.status(500).json({ error: "Failed to retrieve conversation" });
  }
});

app.post("/api/conversations/:id/transcript", async (req, res) => {
  try {
    const { id } = req.params;
    const { sender, text } = req.body;
    const filePath = path.join(CONVERSATIONS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    const content = await fs.promises.readFile(filePath, "utf8");
    const conv = JSON.parse(content);
    conv.transcript.push({
      sender,
      text,
      timestamp: Date.now()
    });
    conv.updatedAt = new Date().toISOString();
    await fs.promises.writeFile(filePath, JSON.stringify(conv, null, 2), "utf8");
    res.json({ success: true, conversation: conv });
  } catch (err) {
    console.error("POST /api/conversations/:id/transcript error:", err);
    res.status(500).json({ error: "Failed to append transcript" });
  }
});

// Database API: Artifacts
app.post("/api/artifacts", async (req, res) => {
  try {
    const { id, conversationId, name, type, serviceName, environment, triggerSource, modifier, files } = req.body;
    const artId = id || "art_" + Math.random().toString(36).substring(2, 11);
    const filePath = path.join(ARTIFACTS_DIR, `${artId}.json`);
    
    let artifact;
    if (fs.existsSync(filePath)) {
      const existingContent = await fs.promises.readFile(filePath, "utf8");
      artifact = JSON.parse(existingContent);
      
      const nextVersion = artifact.versions.length + 1;
      artifact.versions.push({
        version: nextVersion,
        timestamp: Date.now(),
        modifier: modifier || "sre_operator",
        files: files || []
      });
      artifact.updatedAt = new Date().toISOString();
    } else {
      artifact = {
        id: artId,
        conversationId: conversationId || "",
        name: name || "DevOps Pack",
        type: type || "devops_pack",
        serviceName: serviceName || "",
        environment: environment || "",
        triggerSource: triggerSource || "manual",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        versions: [
          {
            version: 1,
            timestamp: Date.now(),
            modifier: modifier || "sre_operator",
            files: files || []
          }
        ]
      };
    }
    
    await fs.promises.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
    
    // Link artifact to conversation
    if (artifact.conversationId) {
      const convPath = path.join(CONVERSATIONS_DIR, `${artifact.conversationId}.json`);
      if (fs.existsSync(convPath)) {
        const convContent = await fs.promises.readFile(convPath, "utf8");
        const conv = JSON.parse(convContent);
        if (!conv.artifacts.includes(artId)) {
          conv.artifacts.push(artId);
          await fs.promises.writeFile(convPath, JSON.stringify(conv, null, 2), "utf8");
        }
      }
    }
    
    res.json(artifact);
  } catch (err) {
    console.error("POST /api/artifacts error:", err);
    res.status(500).json({ error: "Failed to save artifact" });
  }
});

app.get("/api/artifacts", async (req, res) => {
  try {
    const files = await fs.promises.readdir(ARTIFACTS_DIR);
    const artifacts = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await fs.promises.readFile(path.join(ARTIFACTS_DIR, file), "utf8");
        artifacts.push(JSON.parse(content));
      }
    }
    artifacts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    let filtered = artifacts;
    const { serviceName, environment, name, type, triggerType, startDate, endDate } = req.query;
    if (serviceName) {
      filtered = filtered.filter(a => a.serviceName?.toLowerCase().includes(serviceName.toLowerCase()));
    }
    if (environment) {
      filtered = filtered.filter(a => a.environment?.toLowerCase() === environment.toLowerCase());
    }
    if (name) {
      filtered = filtered.filter(a => a.name?.toLowerCase().includes(name.toLowerCase()));
    }
    if (type) {
      filtered = filtered.filter(a => a.type?.toLowerCase() === type.toLowerCase());
    }
    if (triggerType) {
      filtered = filtered.filter(a => (a.triggerSource || a.triggerType || "")?.toLowerCase() === triggerType.toLowerCase());
    }
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      filtered = filtered.filter(a => new Date(a.createdAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filtered = filtered.filter(a => new Date(a.createdAt) <= end);
    }
    
    res.json(filtered);
  } catch (err) {
    console.error("GET /api/artifacts error:", err);
    res.status(500).json({ error: "Failed to list artifacts" });
  }
});

app.get("/api/artifacts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const filePath = path.join(ARTIFACTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Artifact not found" });
    }
    const content = await fs.promises.readFile(filePath, "utf8");
    res.json(JSON.parse(content));
  } catch (err) {
    console.error("GET /api/artifacts/:id error:", err);
    res.status(500).json({ error: "Failed to retrieve artifact" });
  }
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