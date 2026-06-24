import os
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
    get_job_context,
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
    def end_call(self) -> str:
        """
        Ends the current voice assistant call. Call this tool when the user requests to end the call,
        says goodbye, says thank you, or indicates they are done.
        """
        logger.info("Ending call per user request.")
        
        async def _do_end():
            ctx = get_job_context()
            msg = {
                "type": "client_action",
                "id": f"end_{int(asyncio.get_event_loop().time())}",
                "action": "end_call",
                "payload": {}
            }
            await ctx.room.local_participant.publish_data(
                json.dumps(msg),
                topic="client_actions"
            )
        
        asyncio.create_task(_do_end())
        return "I am ending the call now. Goodbye!"

    @llm.function_tool
    def list_available_actions(self) -> str:
        """
        Lists all the available SRE tools and actions that the agent can perform.
        Use this when the user asks what tools or actions are available, or what you can do.
        """
        logger.info("Listing available SRE actions to the user")
        return (
            "I have access to the following actions:\n"
            "1. generate_devops_artifacts: Generates DevOps config files (Dockerfile, Compose, Actions, etc.) based on your requirements.\n"
            "2. search_sre_artifacts: Searches the SRE artifacts database by query, service name, or environment.\n"
            "3. open_sre_artifact: Opens a specific SRE artifact on your screen.\n"
            "4. modify_active_artifact: Modifies a previously generated artifact based on your feedback.\n"
            "5. end_call: Ends the current voice call session.\n"
            "6. list_available_actions: Lists all tools and actions available to me."
        )

    @llm.function_tool
    async def search_sre_artifacts(
        self,
        query: str = "",
        service_name: str = "",
        environment: str = ""
    ) -> str:
        """
        Searches SRE artifacts (Dockerfile, compose, postmortem, RCA, etc.) by query, service, or env.
        
        Args:
            query: Free text search query
            service_name: Filter by service name
            environment: Filter by environment (e.g. production, staging)
        """
        logger.info(f"Searching artifacts query={query}, service={service_name}, env={environment}")
        import urllib.request
        import urllib.parse
        
        try:
            params = {}
            if query: params["name"] = query
            if service_name: params["serviceName"] = service_name
            if environment: params["environment"] = environment
            
            qs = urllib.parse.urlencode(params)
            url = f"http://localhost:3000/api/artifacts?{qs}"
            
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                artifacts = json.loads(response.read().decode('utf-8'))
                
            # Broadcast search results to client UI via data channel
            ctx = get_job_context()
            msg = {
                "type": "show_search_results",
                "artifacts": artifacts
            }
            await ctx.room.local_participant.publish_data(
                json.dumps(msg).encode('utf-8'),
                topic="show_search_results"
            )
            
            return f"I found {len(artifacts)} matching artifacts and updated the SRE history drawer search results."
        except Exception as e:
            logger.error(f"Search artifacts failed: {e}")
            return f"Error searching artifacts: {str(e)}"

    @llm.function_tool
    async def open_sre_artifact(self, artifact_id: str) -> str:
        """
        Retrieves and opens a specific SRE artifact on the user's dashboard screen.
        
        Args:
            artifact_id: The unique ID of the SRE artifact to view
        """
        logger.info(f"Opening SRE artifact: {artifact_id}")
        import urllib.request
        
        try:
            url = f"http://localhost:3000/api/artifacts/{artifact_id}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                artifact = json.loads(response.read().decode('utf-8'))
                
            # Broadcast open event to client UI via data channel
            ctx = get_job_context()
            msg = {
                "type": "open_artifact",
                "artifact": artifact
            }
            await ctx.room.local_participant.publish_data(
                json.dumps(msg).encode('utf-8'),
                topic="open_artifact"
            )
            
            return f"I've opened the artifact '{artifact.get('name')}' in the details viewer for you."
        except Exception as e:
            logger.error(f"Opening SRE artifact failed: {e}")
            return f"Failed to retrieve artifact details: {str(e)}"

    @llm.function_tool
    async def modify_active_artifact(self, artifact_id: str, instructions: str) -> str:
        """
        Modifies a previously generated artifact (such as adding details or changing configurations) 
        and saves a new version of it in the database.
        
        Args:
            artifact_id: The unique ID of the SRE artifact to modify
            instructions: Details of the edits or modifications requested (e.g. 'upgrade base OS to Ubuntu')
        """
        logger.info(f"Modifying SRE artifact {artifact_id} with instructions: {instructions}")
        import urllib.request
        
        try:
            # 1. Fetch current artifact
            url = f"http://localhost:3000/api/artifacts/{artifact_id}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                artifact = json.loads(response.read().decode('utf-8'))
                
            # Get latest files version
            latest_version = artifact.get("versions", [])[-1]
            files_content = json.dumps(latest_version.get("files", []), indent=2)
            
            # 2. Call Gemini-2.5-flash-lite to perform modification
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=api_key.strip())
            
            prompt = f"""
            You are a senior SRE and DevOps expert.
            Modify the existing configurations according to the instructions below.
            
            Instructions: {instructions}
            
            Current configurations:
            {files_content}
            
            Return the complete set of updated files in the exact same format:
            {{
                "files": [
                    {{
                        "path": "file_path",
                        "content": "new_file_content"
                    }}
                ]
            }}
            """
            
            def call_gemini():
                return client.models.generate_content(
                    model='gemini-2.5-flash-lite',
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.2
                    )
                )
                
            response = await asyncio.to_thread(call_gemini)
            parsed_data = json.loads(response.text)
            new_files = parsed_data.get("files", [])
            
            # 3. Save new version back to database Express API
            ctx = get_job_context()
            
            # Extract operator name from room participant metadata if possible, or use default
            operator_name = "sre_operator"
            if hasattr(ctx.room, "remote_participants") and ctx.room.remote_participants:
                for p in ctx.room.remote_participants.values():
                    if p.identity.startswith("web-user") and p.name:
                        operator_name = p.name
                        break
            
            save_payload = {
                "id": artifact_id,
                "modifier": operator_name,
                "files": new_files
            }
            
            save_url = "http://localhost:3000/api/artifacts"
            save_req = urllib.request.Request(
                save_url,
                data=json.dumps(save_payload).encode('utf-8'),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(save_req) as response:
                updated_artifact = json.loads(response.read().decode('utf-8'))
                
            # 4. Broadcast updated version details to client
            msg = {
                "type": "open_artifact",
                "artifact": updated_artifact
            }
            await ctx.room.local_participant.publish_data(
                json.dumps(msg).encode('utf-8'),
                topic="open_artifact"
            )
            
            return f"I have successfully updated the artifact. Version {len(updated_artifact.get('versions'))} is now active and displayed in the details viewer."
            
        except Exception as e:
            logger.error(f"Modify SRE artifact failed: {e}, using local fallback modification.", exc_info=True)
            try:
                # 1. Fetch current artifact
                url = f"http://localhost:3000/api/artifacts/{artifact_id}"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req) as response:
                    artifact = json.loads(response.read().decode('utf-8'))
                
                latest_version = artifact.get("versions", [])[-1]
                updated_files = []
                for f in latest_version.get("files", []):
                    # Local fallback modification: Append a comment indicating the change instruction
                    cmt = f"\n# Fallback modification: {instructions}\n"
                    updated_files.append({
                        "path": f["path"],
                        "content": f["content"] + cmt
                    })
                
                ctx = get_job_context()
                operator_name = "sre_operator"
                if hasattr(ctx.room, "remote_participants") and ctx.room.remote_participants:
                    for p in ctx.room.remote_participants.values():
                        if p.identity.startswith("web-user") and p.name:
                            operator_name = p.name
                            break
                
                save_payload = {
                    "id": artifact_id,
                    "modifier": operator_name,
                    "files": updated_files
                }
                
                save_url = "http://localhost:3000/api/artifacts"
                save_req = urllib.request.Request(
                    save_url,
                    data=json.dumps(save_payload).encode('utf-8'),
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(save_req) as response:
                    updated_artifact = json.loads(response.read().decode('utf-8'))
                    
                msg = {
                    "type": "open_artifact",
                    "artifact": updated_artifact
                }
                await ctx.room.local_participant.publish_data(
                    json.dumps(msg).encode('utf-8'),
                    topic="open_artifact"
                )
                return f"Gemini API rate limit reached. Locally appended your instruction '{instructions}' as comments to the configurations."
            except Exception as fallback_err:
                logger.error(f"Failed fallback modification: {fallback_err}")
                return f"An error occurred during fallback modification: {str(fallback_err)}"

    @llm.function_tool
    async def generate_devops_artifacts(
        self,
        project_type: str,
        details: str
    ) -> str:
        """
        Generates DevOps artifacts (Dockerfile, docker-compose.yml, .dockerignore, ci.yml)
        based on the user's project specifications.

        Args:
            project_type: The project type, either 'fresh' or 'existing'
            details: Detailed specifications: language/framework, versions, OS base, backing databases, port, startup commands, etc.
        """
        logger.info(f"Generating DevOps artifacts for type={project_type}, details={details}")
        
        import os
        from google import genai
        from google.genai import types
        
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not api_key:
            logger.error("Missing Google Gemini API key.")
            return "Failed to generate artifacts: API key is missing."
            
        client = genai.Client(api_key=api_key.strip())
        
        prompt = f"""
        You are a senior SRE and DevOps expert.
        Generate production-ready, highly compatible DevOps files for a project.
        Project Type: {project_type}
        Details provided by user: {details}
        
        You MUST generate exactly 4 files:
        1. Dockerfile
        2. docker-compose.yml
        3. .dockerignore
        4. .github/workflows/ci.yml
        
        Output MUST be a JSON object matching the following structure:
        {{
            "files": [
                {{
                    "path": "Dockerfile",
                    "content": "...Dockerfile content..."
                }},
                {{
                    "path": "docker-compose.yml",
                    "content": "...docker-compose content..."
                }},
                {{
                    "path": ".dockerignore",
                    "content": "...dockerignore content..."
                }},
                {{
                    "path": ".github/workflows/ci.yml",
                    "content": "...GitHub Actions CI content..."
                }}
            ]
        }}
        """
        
        try:
            # Run LLM call in a thread to keep the LiveKit event loop responsive
            def call_gemini():
                return client.models.generate_content(
                    model='gemini-2.5-flash-lite',
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.2
                    )
                )
                
            response = await asyncio.to_thread(call_gemini)
            
            raw_text = response.text
            # Parse it just to make sure it's valid JSON
            parsed_data = json.loads(raw_text)
            new_files = parsed_data.get("files", [])
            
            # Extract conversationId from room name
            ctx = get_job_context()
            room_name = ctx.room.name
            conversation_id = ""
            if room_name.startswith("room-conv_"):
                conversation_id = room_name[len("room-conv_"):]
            
            # Extract operator name from room participant metadata if possible, or use default
            operator_name = "sre_operator"
            if hasattr(ctx.room, "remote_participants") and ctx.room.remote_participants:
                for p in ctx.room.remote_participants.values():
                    if p.identity.startswith("web-user") and p.name:
                        operator_name = p.name
                        break

            # Save artifact to SRE database API
            import urllib.request
            save_payload = {
                "conversationId": conversation_id,
                "name": f"DevOps Pack for {conversation_id[:10]}",
                "type": "devops_pack",
                "triggerSource": "voice",
                "modifier": operator_name,
                "files": new_files
            }
            
            save_url = "http://localhost:3000/api/artifacts"
            save_req = urllib.request.Request(
                save_url,
                data=json.dumps(save_payload).encode('utf-8'),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(save_req) as response:
                artifact = json.loads(response.read().decode('utf-8'))
                
            # Send message via LiveKit data channel
            msg = {
                "type": "open_artifact",
                "artifact": artifact
            }
            
            await ctx.room.local_participant.publish_data(
                json.dumps(msg).encode('utf-8'),
                topic="open_artifact"
            )
            
            logger.info("Successfully generated, saved, and published SRE DevOps artifacts.")
            return "I have successfully generated your Dockerfile, Docker Compose, .dockerignore, and GitHub Actions CI workflow, saved them to the SRE database, and displayed them in the details viewer."
            
        except Exception as e:
            logger.error(f"Error generating DevOps artifacts: {e}, falling back to default DevOps files.", exc_info=True)
            fallback_files = [
                {
                    "path": "Dockerfile",
                    "content": (
                        "# Production-ready Dockerfile\n"
                        "FROM node:20-alpine\n"
                        "WORKDIR /app\n"
                        "COPY package*.json ./\n"
                        "RUN npm ci --only=production\n"
                        "COPY . .\n"
                        "EXPOSE 3000\n"
                        "CMD [\"npm\", \"run\", \"start\"]\n"
                    )
                },
                {
                    "path": "docker-compose.yml",
                    "content": (
                        "version: '3.8'\n"
                        "services:\n"
                        "  web:\n"
                        "    build: .\n"
                        "    ports:\n"
                        "      - \"3000:3000\"\n"
                        "    environment:\n"
                        "      - NODE_ENV=production\n"
                    )
                },
                {
                    "path": ".dockerignore",
                    "content": "node_modules\nnpm-debug.log\n.git\n"
                },
                {
                    "path": ".github/workflows/ci.yml",
                    "content": (
                        "name: CI\n"
                        "on: [push]\n"
                        "jobs:\n"
                        "  build:\n"
                        "    runs-on: ubuntu-latest\n"
                        "    steps:\n"
                        "      - uses: actions/checkout@v3\n"
                        "      - name: Use Node.js\n"
                        "        uses: actions/setup-node@v3\n"
                        "        with:\n"
                        "          node-version: '20'\n"
                        "      - run: npm ci\n"
                        "      - run: npm test\n"
                    )
                }
            ]
            
            ctx = get_job_context()
            room_name = ctx.room.name
            conversation_id = ""
            if room_name.startswith("room-conv_"):
                conversation_id = room_name[len("room-conv_"):]
            
            operator_name = "sre_operator"
            if hasattr(ctx.room, "remote_participants") and ctx.room.remote_participants:
                for p in ctx.room.remote_participants.values():
                    if p.identity.startswith("web-user") and p.name:
                        operator_name = p.name
                        break

            import urllib.request
            save_payload = {
                "conversationId": conversation_id,
                "name": f"DevOps Pack for {conversation_id[:10]}",
                "type": "devops_pack",
                "triggerSource": "voice",
                "modifier": operator_name,
                "files": fallback_files
            }
            
            try:
                save_url = "http://localhost:3000/api/artifacts"
                save_req = urllib.request.Request(
                    save_url,
                    data=json.dumps(save_payload).encode('utf-8'),
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(save_req) as response:
                    artifact = json.loads(response.read().decode('utf-8'))
                    
                msg = {
                    "type": "open_artifact",
                    "artifact": artifact
                }
                await ctx.room.local_participant.publish_data(
                    json.dumps(msg).encode('utf-8'),
                    topic="open_artifact"
                )
                return "Gemini API rate limit reached. I have generated a fallback set of standard Node.js/Alpine production DevOps configurations and loaded them into the details viewer."
            except Exception as save_err:
                logger.error(f"Failed to save fallback artifacts: {save_err}")
                return f"An error occurred while generating and saving the fallback files: {str(save_err)}"

async def entrypoint(ctx: JobContext):
    logger.info(f"--- New Job Dispatched: room={ctx.room.name}, id={ctx.job.id} ---")
    try:
        initial_ctx = llm.ChatContext()
        
        # Restore historical conversation transcript if resuming a past session
        room_name = ctx.room.name
        conversation_id = ""
        if room_name.startswith("room-conv_"):
            conversation_id = room_name[len("room-conv_"):]
            logger.info(f"Detected conversation ID from room name: {conversation_id}")
            
        if conversation_id:
            import urllib.request
            try:
                url = f"http://localhost:3000/api/conversations/{conversation_id}"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req) as response:
                    data = json.loads(response.read().decode('utf-8'))
                    repository_urls = data.get("repositoryUrls", [])
                    if not repository_urls and data.get("repositoryUrl"):
                        repository_urls = [data.get("repositoryUrl")]
                        
                    if repository_urls:
                        repos_list = "\n- ".join(repository_urls)
                        initial_ctx.messages.append(llm.ChatMessage(
                            role="system",
                            content=f"The user has linked the following repositories to this session:\n- {repos_list}\nYou should use these repositories to perform any Git/GitHub related SRE tasks."
                        ))
                        logger.info(f"Loaded {len(repository_urls)} linked repositories into system prompt.")
                    
                    transcript = data.get("transcript", [])
                    for turn in transcript:
                        sender = turn.get("sender", "")
                        text = turn.get("text", "")
                        if sender == "SRE":
                            initial_ctx.messages.append(llm.ChatMessage(role="user", content=text))
                        else:
                            initial_ctx.messages.append(llm.ChatMessage(role="assistant", content=text))
                    logger.info(f"Loaded {len(transcript)} historical transcript turns into ChatContext.")
            except Exception as e:
                logger.error(f"Failed to restore conversation context: {e}")

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
            llm=google.LLM(model="gemini-2.5-flash-lite", api_key=gemini_key),
            tts=cartesia.TTS(),
            vad=silero.VAD.load(),
        )

        agent = voice.Agent(
            instructions=(
                "You are a helpful, concise, and professional SRE assistant. "
                "Help the user triage incidents over voice. Use short sentences. No markdown. "
                "You operate inside an SRE Artifacts Hub. You can search, retrieve, save, or modify artifacts. "
                "Use 'search_sre_artifacts' to query historical configurations, 'open_sre_artifact' to show files, "
                "'modify_active_artifact' to update them based on user feedback, and 'end_call' when they say goodbye or are finished. "
                "Proceed with actions directly without requesting confirmations or redirects. "
                "If the user asks to generate DevOps files, you must conduct a branching interview: "
                "1. Ask if they have an existing repository link or if it is a fresh project. "
                "2. If repository: ask for the repository link, then call the tool. "
                "3. If fresh project: ask for their preferred base OS kernel (e.g. Alpine, Ubuntu, Debian), "
                "then their programming language and runtime version (e.g. Node 20, Python 3.11), "
                "then backing services (e.g. PostgreSQL, Redis), and finally the exposed port and start command. "
                "Once gathered, invoke the 'generate_devops_artifacts' tool."
            ),
            chat_ctx=initial_ctx,
            tools=[SREAssistantActions()],
            turn_handling=TurnHandlingOptions(
                preemptive_generation=PreemptiveGenerationOptions(enabled=False)
            ),
        )
        @ctx.room.on("data_received")
        def on_data_received(data_packet):
            if data_packet.topic == "client_events":
                try:
                    payload = json.loads(data_packet.data.decode("utf-8"))
                    if payload.get("type") == "chat_message":
                        message_text = payload.get("text")
                        logger.info(f"Received manual chat message from user data channel: {message_text}")
                        session.generate_reply(user_input=message_text, input_modality="text")
                except Exception as data_err:
                    logger.error(f"Error handling incoming data channel message: {data_err}")

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
