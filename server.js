import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
// Import the secure token tools from the LiveKit SDK
import { AccessToken } from "livekit-server-sdk";

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// Ensure you have LIVEKIT_API_KEY and LIVEKIT_API_SECRET in your .env
const LIVEKIT_URL = process.env.VOICE_PLATFORM_URL; 
const LIVEKIT_API_KEY = process.env.VOICE_PLATFORM_API_KEY;
const LIVEKIT_API_SECRET = process.env.VOICE_PLATFORM_API_SECRET; // Ensure this is added to .env!

app.post("/api/voice-token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({ 
        error: "Backend misconfiguration: Missing LiveKit Keys or Secret in .env" 
      });
    }

    // 1. Generate unique identifiers for this call session
    const participantIdentity = "web-user-" + Math.floor(Math.random() * 10000);
    const roomName = "production-voice-room";

    // 2. Initialize the cryptographic signer
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: "Web Caller",
      ttl: "15m", // Token expires safely in 15 minutes
    });

    // 3. Grant full permissions to join the room and transmit audio
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,      // Allow user to stream microphone
      canPublishData: true,  // Allow user to send data channel actions
      canSubscribe: true,    // Allow user to hear the agent
    });

    // 4. Generate the actual stringified secure JWT token
    const tokenStr = await at.toJwt();
    console.log(`✅ Cryptographic token generated successfully for ${participantIdentity}`);

    // 5. Return token + connection properties down to client.js
    res.json({
      rtc_url: LIVEKIT_URL, 
      token: tokenStr,
    });

  } catch (err) {
    console.error("💥 Token generation crashed:", err.message);
    res.status(500).json({ error: "Failed to build access token", detail: err.message });
  }
});

app.listen(3000, () => console.log("🚀 Server running at http://localhost:3000"));