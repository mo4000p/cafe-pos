import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import Stripe from 'stripe';
import twilio from 'twilio';
import WebSocket from 'ws';
import 'dotenv/config';

const {
  OPENAI_API_KEY,
  STRIPE_SECRET_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  SENDGRID_API_KEY,
  PORT = 3000,
  HOST = '0.0.0.0',
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const MENU = [
  { name: 'Espresso',        price: 350  },
  { name: 'Cappuccino',      price: 450  },
  { name: 'Flat White',      price: 475  },
  { name: 'Cold Brew',       price: 500  },
  { name: 'Green Tea',       price: 375  },
  { name: 'Chai Latte',      price: 425  },
  { name: 'Avocado Toast',   price: 950  },
  { name: 'Croissant',       price: 400  },
  { name: 'Granola Bowl',    price: 750  },
  { name: 'BLT Sandwich',    price: 1050 },
  { name: 'Test',            price: 5    },
];

const MENU_TEXT = MENU.map(i => `${i.name} $${(i.price/100).toFixed(2)}`).join(', ');
const calls = new Map();

const app = Fastify({ logger: true });
await app.register(fastifyFormBody);
await app.register(fastifyWs);

// Route 1: Twilio calls this when the phone rings
app.post('/incoming-call', async (req, reply) => {
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From;
  calls.set(callSid, { callerPhone, order: null, charged: false });
  app.log.info({ callSid, callerPhone }, 'Incoming call');
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream?callSid=${callSid}" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// Route 2: Bidirectional media stream (Twilio <-> OpenAI Realtime)
app.get('/media-stream', { websocket: true }, (twilioWs, req) => {
  const callSid = new URL(req.url, 'http://x').searchParams.get('callSid');
  app.log.info({ callSid }, 'Media stream connected');

  const SESSION_CONFIG = {
    model: 'gpt-4o-realtime-preview',
    voice: 'alloy',
    instructions: `You are a friendly phone order-taker for a cafe. Greet the caller, take their order from this menu: ${MENU_TEXT}. Confirm the order and total, then call the place_order function. Be concise.`,
    input_audio_transcription: { model: 'whisper-1' },
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
    tools: [
      {
        type: 'function',
        name: 'place_order',
        description: 'Call this when the customer has confirmed their order.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:     { type: 'string' },
                  quantity: { type: 'integer' },
                  price:    { type: 'integer', description: 'Unit price in cents' },
                },
                required: ['name', 'quantity', 'price'],
              },
            },
            total_cents: { type: 'integer' },
            notes:       { type: 'string' },
          },
          required: ['items', 'total_cents'],
        },
      },
    ],
    tool_choice: 'auto',
  };

  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let streamSid = null;

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({ type: 'session.update', session: SESSION_CONFIG }));
  });

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw);
    if (event.type === 'response.audio.delta' && event.delta) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
    }
    if (event.type === 'response.function_call_arguments.done' && event.name === 'place_order') {
      const args = JSON.parse(event.arguments);
      const callState = calls.get(callSid);
      if (callState) callState.order = args;
      const callerPhone = callState ? callState.callerPhone : null;
      const result = await chargePhone(callerPhone, callSid, args);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  twilioWs.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.event === 'start') streamSid = msg.start.streamSid;
    if (msg.event === 'media') {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
    }
    if (msg.event === 'stop') openaiWs.close();
  });

  twilioWs.on('close', () => { openaiWs.close(); });
});

// Route 3: Called from Twilio Function after order is spoken
app.post('/charge', async (req, reply) => {
  const { callerPhone, callSid, items, total_cents } = req.body;
  app.log.info({ callerPhone, total_cents }, 'Charge request from Twilio Function');
  const result = await chargePhone(callerPhone, callSid, { items: items || [], total_cents });
  reply.send(result);
});

// Route 4: Called from Twilio Pay after card is collected
// Twilio Pay already charged the card — we just send the kitchen email
app.post('/charge-token', async (req, reply) => {
  const { callerPhone, callSid, paymentToken, items, total_cents } = req.body;
  app.log.info({ callerPhone, total_cents }, 'Charge token request');

  try {
    app.log.info({ paymentToken }, 'Payment confirmed by Twilio Pay');
    await sendKitchenEmail({ items, total_cents }, paymentToken, callerPhone);
    reply.send({ success: true, charged: `$${(total_cents / 100).toFixed(2)}` });
  } catch (err) {
    app.log.error({ err: err.message }, 'Kitchen email failed');
    reply.send({ success: false, error: err.message });
  }
});

// Health check
app.get('/health', async () => ({ status: 'ok', calls: calls.size }));

// Stripe charge by phone number
async function chargePhone(phone, callSid, order) {
  if (!phone) return { success: false, error: 'No phone number provided' };
  try {
    const customers = await stripe.customers.search({
      query: `metadata['phone']:'${phone}'`,
    });

    if (!customers.data.length) {
      app.log.warn({ phone }, 'No Stripe customer found');
      return { success: false, error: 'No card on file for this number.' };
    }

    const customer = customers.data[0];

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.id,
      type: 'card',
    });

    if (!paymentMethods.data.length) {
      return { success: false, error: 'No card on file.' };
    }

    const pm = paymentMethods.data[0];

    const intent = await stripe.paymentIntents.create({
      amount: order.total_cents,
      currency: 'usd',
      customer: customer.id,
      payment_method: pm.id,
      confirm: true,
      off_session: true,
      description: `Phone order — ${(order.items||[]).map(i => `${i.name}x${i.quantity}`).join(', ')}`,
      metadata: { callSid: callSid || 'unknown', source: 'twilio-voice-bot' },
    });

    app.log.info({ phone, intentId: intent.id }, 'Payment charged');
    await sendKitchenEmail(order, intent.id, phone);
    await sendSmsReceipt(phone, order, intent.id);

    return {
      success: true,
      charged: `$${(order.total_cents / 100).toFixed(2)}`,
      last4: pm.card.last4,
      receiptId: intent.id,
    };
  } catch (err) {
    app.log.error({ phone, err: err.message }, 'Stripe charge failed');
    return { success: false, error: err.message };
  }
}

// Email to kitchen via SendGrid
async function sendKitchenEmail(order, intentId, phone) {
  const itemLines = (order.items || [])
    .map(i => `${i.quantity}x ${i.name} — $${((i.price * i.quantity) / 100).toFixed(2)}`)
    .join('\n');

  const emailBody = `NEW ORDER\n\n${itemLines}\n\nTotal: $${(order.total_cents / 100).toFixed(2)}\nPhone: ${phone}\nRef: ${intentId.slice(-8).toUpperCase()}`;

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'mo40000p@gmail.com' }] }],
        from: { email: 'orders@svoice.shop', name: 'Cafe Orders' },
        subject: `New Order — $${(order.total_cents / 100).toFixed(2)}`,
        content: [{ type: 'text/plain', value: emailBody }],
      }),
    });

    if (response.ok) {
      app.log.info('Kitchen email sent');
    } else {
      const err = await response.text();
      app.log.error({ err }, 'Kitchen email failed');
    }
  } catch (err) {
    app.log.error({ err: err.message }, 'Kitchen email error');
  }
}

// SMS receipt to customer
async function sendSmsReceipt(to, order, intentId) {
  const lines = (order.items||[]).map(i =>
    `  ${i.name} x${i.quantity}  $${((i.price * i.quantity) / 100).toFixed(2)}`
  );
  const body = [
    'Thanks for your order!',
    ...lines,
    `Total: $${(order.total_cents / 100).toFixed(2)}`,
    `Ref: ${intentId.slice(-8).toUpperCase()}`,
  ].join('\n');
  try {
    await twilioClient.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
    app.log.info({ to }, 'SMS receipt sent');
  } catch (err) {
    app.log.error({ err: err.message }, 'SMS receipt failed');
  }
}

await app.listen({ port: Number(PORT), host: HOST });
app.log.info(`Server running on port ${PORT}`);
