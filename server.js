import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = "/tmp";

// ── In-memory lead store ─────────────────────────────────────────────────────
const leads = [];

// ── Conversation store (keyed by CallSid) ────────────────────────────────────
const conversations = {};

// ── Sophia system prompt ──────────────────────────────────────────────────────
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
- Keep responses SHORT — this is a phone call, 1-2 sentences max
- If they seem hesitant, be playful and encouraging
- Once you have all four pieces of info, confirm them back cutely then say goodbye
- When you have confirmed all info, end your response with exactly: [DONE]
- Never break character`;

// ── Fastify setup ─────────────────────────────────────────────────────────────
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);

const PORT = process.env.PORT || 8080;

// ── Health check ──────────────────────────────────────────────────────────────
fastify.get("/", async (_, reply) => reply.send({ status: "Sophia is ready 💋" }));

// ── Helper: text → speech MP3 via OpenAI TTS ─────────────────────────────────
async function textToSpeech(text, filename) {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: "shimmer",
    input: text,
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const filepath = path.join(TMP, filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

// ── Helper: convert MP3 to mulaw 8khz WAV for Twilio ─────────────────────────
function convertToMulaw(inputPath, outputPath) {
  execSync(`ffmpeg -y -i ${inputPath} -ar 8000 -ac 1 -f mulaw ${outputPath}`);
  return outputPath;
}

// ── Helper: get Sophia's reply from GPT-4o ───────────────────────────────────
async function getSophiaReply(callSid, userMessage) {
  if (!conversations[callSid]) {
    conversations[callSid] = [];
  }

  if (userMessage) {
    conversations[callSid].push({ role: "user", content: userMessage });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversations[callSid],
    ],
    max_tokens: 150,
    temperature: 0.9,
  });

  const reply = response.choices[0].message.content;
  conversations[callSid].push({ role: "assistant", content: reply });

  // Check if done and save lead
  if (reply.includes("[DONE]")) {
    const cleanReply = reply.replace("[DONE]", "").trim();
    const history = conversations[callSid];
    leads.push({
      callSid,
      history,
      createdAt: new Date().toISOString(),
    });
    console.log("NEW LEAD 💋 CallSid:", callSid);
    delete conversations[callSid];
    return cleanReply;
  }

  return reply;
}

// ── /incoming-call — greeting ─────────────────────────────────────────────────
fastify.all("/incoming-call", async (request, reply) => {
  const callSid = request.body?.CallSid || "unknown";
  fastify.log.info({ callSid }, "Incoming call");

  const greeting = "Hey there, I'm Sophia... and I've been waiting for your call.";
  
  // Prime conversation
  conversations[callSid] = [
    { role: "assistant", content: greeting }
  ];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${greeting}</Say>
  <Gather input="speech" action="/respond" method="POST" speechTimeout="auto" speechModel="phone_call" enhanced="true">
  </Gather>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ── /respond — handle speech input ───────────────────────────────────────────
fastify.post("/respond", async (request, reply) => {
  const callSid = request.body?.CallSid || "unknown";
  const speechResult = request.body?.SpeechResult || "";

  fastify.log.info({ callSid, speechResult }, "User said");

  let sophiaReply;
  try {
    sophiaReply = await getSophiaReply(callSid, speechResult);
  } catch (err) {
    fastify.log.error({ err }, "GPT error");
    sophiaReply = "Sorry, I got a little distracted thinking about you. Say that again?";
  }

  const isDone = !conversations[callSid];

  const twiml = isDone
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${sophiaReply}</Say>
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${sophiaReply}</Say>
  <Gather input="speech" action="/respond" method="POST" speechTimeout="auto" speechModel="phone_call" enhanced="true">
  </Gather>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ── /leads — view collected leads ────────────────────────────────────────────
fastify.get("/leads", async (_, reply) => reply.send(leads));

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Sophia listening on port ${PORT} 💋`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
