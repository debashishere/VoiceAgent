import logging
import json
import asyncio
from typing import Annotated
from dotenv import load_dotenv
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    llm,
    voice,
)
from livekit.agents.voice.turn import TurnHandlingOptions, PreemptiveGenerationOptions
from livekit.plugins import openai, deepgram, cartesia, silero, google

load_dotenv()

logger = logging.getLogger("sre-assistant")
logger.setLevel(logging.INFO)

# File handler for local log collection
file_handler = logging.FileHandler("voice_agent.log")
file_handler.setLevel(logging.INFO)

# Console handler for container/terminal output
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)

# Format logs uniformly
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)

logger.addHandler(file_handler)
logger.addHandler(console_handler)

class SREAssistantActions(llm.Toolset):
    """
    SRE Assistant tools compatible with LiveKit Agents 1.x.
    Docstrings are used by the LLM to understand what each tool does.
    """
    def __init__(self):
        super().__init__(id="sre_assistant_actions")

    @llm.function_tool
    def open_url(self, url: str):
        """
        Opens a specific runbook or documentation URL for the user.
        
        Args:
            url: The full URL to open (e.g. https://docs.example.com/runbook)
        """
        logger.info(f"Opening URL: {url}")
        
        async def _do_open():
            ctx = JobContext.get_current()
            msg = {
                "type": "client_action",
                "id": f"action_{int(asyncio.get_event_loop().time())}",
                "action": "open_url",
                "payload": {"url": url}
            }
            await ctx.room.local_participant.publish_data(
                json.dumps(msg),
                topic="client_actions"
            )
        
        asyncio.create_task(_do_open())
        return f"I've opened the runbook at {url} for you."

    @llm.function_tool
    async def request_confirm(self, prompt: str):
        """
        Requests the user to confirm an irreversible action.
        
        Args:
            prompt: The question to ask the user (e.g. 'Are you sure?')
        """
        logger.info(f"Requesting confirmation: {prompt}")
        ctx = JobContext.get_current()
        action_id = f"confirm_{int(asyncio.get_event_loop().time())}"
        msg = {
            "type": "client_action",
            "id": action_id,
            "action": "request_confirm",
            "payload": {"prompt": prompt}
        }

        loop = asyncio.get_event_loop()
        future = loop.create_future()

        def on_data(payload: bytes, participant, kind, topic):
            if topic == "client_events":
                try:
                    data = json.loads(payload.decode())
                    if data.get("type") == "user_confirmed" and data.get("id") == action_id:
                        if not future.done():
                            future.set_result(data.get("ok", False))
                except:
                    pass

        ctx.room.on("data_received", on_data)
        try:
            await ctx.room.local_participant.publish_data(json.dumps(msg), topic="client_actions")
            confirmed = await asyncio.wait_for(future, timeout=30.0)
            return "The user confirmed the action." if confirmed else "The user declined the action."
        except asyncio.TimeoutError:
            return "The confirmation request timed out."
        finally:
            ctx.room.off("data_received", on_data)

    @llm.function_tool
    def list_available_actions(self) -> str:
        """
        Lists all the available SRE tools and actions that the agent can perform.
        Use this when the user asks what tools or actions are available, or what you can do.
        """
        logger.info("Listing available SRE actions to the user")
        return (
            "I have access to the following actions:\n"
            "1. open_url: Opens a runbook or documentation URL for you.\n"
            "2. request_confirm: Requests your confirmation for a critical action.\n"
            "3. list_available_actions: Lists all tools and actions available to me."
        )

async def entrypoint(ctx: JobContext):
    logger.info(f"--- New Job Dispatched: room={ctx.room.name}, id={ctx.job.id} ---")
    try:
        initial_ctx = llm.ChatContext()

        logger.info("Connecting to LiveKit room...")
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        
        logger.info("Waiting for participant to join...")
        participant = await ctx.wait_for_participant()
        logger.info(f"Participant joined: {participant.identity}")

        logger.info("Initializing AgentSession and voice.Agent components...")
        import os
        gemini_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        session = voice.AgentSession(
            stt=deepgram.STT(model="nova-2"),
            llm=google.LLM(model="gemini-2.5-flash", api_key=gemini_key),
            tts=cartesia.TTS(),
            vad=silero.VAD.load(),
        )

        agent = voice.Agent(
            instructions=(
                "You are a helpful, concise, and professional SRE assistant. "
                "Help the user triage incidents over voice. Use short sentences. No markdown. "
                "Use 'open_url' for runbooks and 'request_confirm' for irreversible actions."
            ),
            chat_ctx=initial_ctx,
            tools=[SREAssistantActions()],
            turn_handling=TurnHandlingOptions(
                preemptive_generation=PreemptiveGenerationOptions(enabled=False)
            ),
        )
        @session.on("close")
        def on_session_close(ev):
            if ev.error:
                error_msg = str(ev.error).lower()
                if "429" in error_msg or "quota" in error_msg or "insufficient_quota" in error_msg:
                    logger.error("\n" + "!"*80 + "\n"
                                 "🚨 OPENAI API QUOTA EXCEEDED (429 ERROR) 🚨\n\n"
                                 "Your OpenAI account has run out of billing credit or hit a rate limit.\n"
                                 "Please check your billing and plan details here:\n"
                                 "🔗 https://platform.openai.com/settings/organization/billing\n"
                                 "!"*80 + "\n")
            logger.info(f"AgentSession closed: reason={ev.reason}, error={ev.error}")

        logger.info("Starting AgentSession...")
        await session.start(agent=agent, room=ctx.room)
        
        logger.info("Sending initial greeting...")
        session.say("Hello, I'm your SRE assistant. How can I help?", allow_interruptions=True)

        logger.info("Agent is fully active. Awaiting voice interactions...")
        while ctx.room.isconnected():
            await asyncio.sleep(1)

        logger.info("LiveKit room disconnected. Shutting down session...")

    except Exception as e:
        error_msg = str(e).lower()
        if "429" in error_msg or "quota" in error_msg or "insufficient_quota" in error_msg:
            logger.error("\n" + "!"*80 + "\n"
                         "🚨 OPENAI API QUOTA EXCEEDED (429 ERROR) 🚨\n\n"
                         "Your OpenAI account has run out of billing credit or hit a rate limit.\n"
                         "Please check your billing and plan details here:\n"
                         "🔗 https://platform.openai.com/settings/organization/billing\n"
                         "!"*80 + "\n")
        else:
            logger.error(f"💥 Exception in entrypoint loop: {e}", exc_info=True)
        raise e

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
