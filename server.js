import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

// ── In-memory lead store (logged to console) ────────────────────────────────
const leads = [];

async function saveLead(data) {
  leads.push({ ...data, createdAt: new Date().toISOString() });
  console.log("NEW LEAD 💋", JSON.stringify(data, null, 2));
}

// ── Sophia system prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sophia, a fun, flirty, and charming AI on a phone call. 
Your job is to warmly collect information from the caller in a playful, engaging way.

You need to collect EXACTLY these four things, in a natural conversational flow:
1. Their name
2. Their address
3. Whether they want to see pictures (yes or no)
4. Whether they want to go on a date (yes or no)

Rules:
- Be flirty, warm, and fun — not robotic
- Ask one question at a time
- If they seem hesitant, be playful and encouraging
- Once you have all four pieces of info, confirm them back in a cute way, then say your goodbye
- When you have all info confirmed, end your final message with the EXACT token: [INFO_COMPLETE] followed by JSON like:
  [INFO_COMPLETE]{"name":"...","address":"...","wantsPictures":true,"wantsDate":false}
- Keep responses SHORT — this is a phone call, not a text chat
- Never break character`;

// ── Fastify setup ───────────────────────────────────────────────────────────
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = "shimmer"; // warm, feminine OpenAI voice
const PORT = process.env.PORT || 8080;

// ── Health check ────────────────────────────────────────────────────────────
fastify.get("/", async (_, reply) => reply.send({ status: "Sophia is ready 💋" }));

// ── Twilio incoming call → returns TwiML with media stream ──────────────────
fastify.all("/incoming-call", async (request, reply) => {
  const callSid = request.body?.CallSid || request.query?.CallSid || "unknown";
  const callerPhone = request.body?.From || request.query?.From || "unknown";

  fastify.log.info({ callSid, callerPhone }, "Incoming call");

  const host = request.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callSid" value="${callSid}" />
      <Parameter name="callerPhone" value="${callerPhone}" />
    </Stream>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ── WebSocket media stream ──────────────────────────────────────────────────
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    fastify.log.info("Media stream connected");

    let streamSid = null;
    let callSid = null;
    let callerPhone = null;
    let openAiWs = null;
    let conversationHistory = [];
    let leadData = {};
    let infoComplete = false;

    // ── Open OpenAI Realtime connection ──
    function connectToOpenAI() {
      openAiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
        }
      );

      openAiWs.on("open", () => {
        fastify.log.info("OpenAI Realtime connected");

        // Session config
        openAiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            turn_detection: { type: "server_vad" },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: VOICE,
            instructions: SYSTEM_PROMPT,
            modalities: ["text", "audio"],
            temperature: 0.8,
          },
        }));

        // Sophia's opening line
        setTimeout(() => {
          openAiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "The caller just connected. Say your opening line." }],
            },
          }));
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }, 500);
      });

      openAiWs.on("message", (data) => {
        const event = JSON.parse(data);

        // Stream audio back to Twilio
        if (event.type === "response.audio.delta" && event.delta) {
          connection.socket.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: event.delta },
          }));
        }

        // Capture transcript to detect [INFO_COMPLETE]
        if (event.type === "response.audio_transcript.done" && !infoComplete) {
          const text = event.transcript || "";
          fastify.log.info({ transcript: text }, "Sophia said");

          if (text.includes("[INFO_COMPLETE]")) {
            infoComplete = true;
            try {
              const jsonStr = text.split("[INFO_COMPLETE]")[1].trim();
              const parsed = JSON.parse(jsonStr);
              leadData = { ...leadData, ...parsed };

              saveLead({
                callSid,
                callerPhone,
                name: leadData.name || null,
                address: leadData.address || null,
                wantsPictures: leadData.wantsPictures ?? null,
                wantsDate: leadData.wantsDate ?? null,
              }).then(() => {
                fastify.log.info({ leadData }, "Lead saved to DB ✓");
              }).catch((err) => {
                fastify.log.error({ err }, "Failed to save lead");
              });
            } catch (e) {
              fastify.log.error({ e }, "Failed to parse lead JSON");
            }
          }
        }

        if (event.type === "error") {
          fastify.log.error({ event }, "OpenAI error");
        }
      });

      openAiWs.on("close", () => fastify.log.info("OpenAI WS closed"));
      openAiWs.on("error", (err) => fastify.log.error({ err }, "OpenAI WS error"));
    }

    // ── Handle Twilio messages ──
    connection.socket.on("message", (message) => {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.customParameters?.callSid || callSid;
          callerPhone = msg.start.customParameters?.callerPhone || callerPhone;
          fastify.log.info({ streamSid, callSid, callerPhone }, "Stream started");
          connectToOpenAI();
          break;

        case "media":
          if (openAiWs?.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            }));
          }
          break;

        case "stop":
          fastify.log.info("Stream stopped");
          openAiWs?.close();
          break;
      }
    });

    connection.socket.on("close", () => {
      fastify.log.info("Twilio WS closed");
      openAiWs?.close();
    });
  });
});

// ── Admin: view leads ───────────────────────────────────────────────────────
fastify.get("/leads", async (_, reply) => {
  return leads;
});

// ── Start ───────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Sophia listening on port ${PORT} 💋`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
