import asyncio
import logging
import json
import wave
import numpy as np
from livekit import rtc
from livekit.agents import JobContext, WorkerOptions, cli, llm
from livekit.plugins import silero

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mock-agent")

class MockSREActions(llm.FunctionContext):
    @llm.ai_callable(description="Opens a specific runbook URL.")
    async def open_url(self, url: str):
        logger.info(f"MOCK: Opening URL {url}")
        ctx = JobContext.get_current()
        msg = {
            "type": "client_action",
            "id": "mock_open",
            "action": "open_url",
            "payload": {"url": url}
        }
        await ctx.room.local_participant.publish_data(json.dumps(msg), topic="client_actions")
        return f"Opened {url}"

    @llm.ai_callable(description="Requests confirmation.")
    async def request_confirm(self, prompt: str):
        logger.info(f"MOCK: Requesting confirm: {prompt}")
        return "The user (mock) says YES."

async def entrypoint(ctx: JobContext):
    logger.info("Mock agent starting...")
    await ctx.connect()

    # Create an audio source for "TTS" (sine wave)
    source = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mock-tts", source)
    options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    publication = await ctx.room.local_participant.publish_track(track, options)
    
    # Simple sine wave generator to simulate "speech"
    async def play_beep():
        sample_rate = 48000
        duration = 0.5 # seconds
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        tone = np.sin(440 * t * 2 * np.pi) * 0.1 # 440Hz
        audio_data = (tone * 32767).astype(np.int16)
        
        # Send in 20ms chunks
        chunk_size = int(sample_rate * 0.02)
        for i in range(0, len(audio_data), chunk_size):
            chunk = audio_data[i:i+chunk_size]
            if len(chunk) < chunk_size: break
            frame = rtc.AudioFrame(chunk.tobytes(), sample_rate, 1, chunk_size)
            await source.capture_frame(frame)
            await asyncio.sleep(0.02)

    # VAD to "hear" the user
    vad = silero.VAD()
    
    async def process_audio():
        # Just listen for ANY audio and respond with a beep and an action
        logger.info("Listening for your voice (VAD active)...")
        
        # In a real agent, we'd pipe audio to STT. 
        # Here we just wait 5 seconds and then "trigger" a mock action to show it works.
        await asyncio.sleep(5)
        logger.info("Mock Agent: I'm 'hearing' you now. I will open a URL as a test.")
        
        await play_beep()
        
        # Call the tool directly to demonstrate
        actions = MockSREActions()
        await actions.open_url("https://www.google.com")
        
        msg = {"type": "agent_state", "state": "finished task"}
        await ctx.room.local_participant.publish_data(json.dumps(msg))

    asyncio.create_task(process_audio())
    
    # Keep alive
    while True:
        await asyncio.sleep(1)

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
