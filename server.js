import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import Stripe from 'stripe';
import WebSocket from 'ws';
import 'dotenv/config';

const {
  OPENAI_API_KEY,
  STRIPE_SECRET_KEY,
  TELNYX_API_KEY,       // for SMS only
  TELNYX_FROM_NUMBER,   // Telnyx number for outbound SMS (or keep TWILIO_FROM_NUMBER if porting later)
  SENDGRID_API_KEY,
  PORT = 3000,
  HOST = '0.0.0.0',
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

const MENU = [
  { name: 'Small Pizza',           price: 10 },
  { name: 'Medium Pizza',          price: 10 },
  { name: 'Large Pizza',           price: 10 },
  { name: 'One Pizza Family Deal',  price: 10 },
  { name: 'Two Pizza Family Deal',  price: 10 },
  { name: 'Small Coke',            price: 10 },
  { name: 'Medium Coke',           price: 10 },
  { name: 'Large Coke',            price: 10 },
  { name: 'Small Sprite',          price: 10 },
  { name: 'Medium Sprite',         price: 10 },
  { name: 'Large Sprite',          price: 10 },
  { name: 'Small Mountain Dew',    price: 10 },
  { name: 'Medium Mountain Dew',   price: 10 },
  { name: 'Large Mountain Dew',    price: 10 },
  { name: 'House Salad',           price: 10 },
  { name: 'Extra Dressing',        price: 10 },
  { name: 'Extra Cheese',          price: 10 },
  { name: 'Pepperoni',             price: 10 },
  { name: 'Sausage',               price: 10 },
  { name: 'Onion',                 price: 10 },
  { name: 'Mushroom',              price: 10 },
];

const MENU_TEXT = MENU.map(i => `${i.name} $${(i.price / 100).toFixed(2)}`).join(', ');
const calls = new Map();

// ── Store hours ───────────────────────────────────────────────────────────────
function isStoreOpen() {
  const override = process.env.STORE_OPEN;
  if (override === 'true')  return true;
  if (override === 'false') return false;

  const timezone  = process.env.STORE_TIMEZONE  ?? 'America/Chicago';
  const openHour  = parseInt(process.env.STORE_OPEN_HOUR  ?? '7');
  const closeHour = parseInt(process.env.STORE_CLOSE_HOUR ?? '22');

  const now        = new Date();
  const local      = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const nowMinutes = local.getHours() * 60 + local.getMinutes();

  return nowMinutes >= openHour * 60 && nowMinutes < closeHour * 60;
}

// ── Telnyx SMS helper ─────────────────────────────────────────────────────────
async function sendTelnyxSms(to, body) {
  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: TELNYX_FROM_NUMBER,
      to,
      text: body,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telnyx SMS failed: ${err}`);
  }
}

const app = Fastify({ logger: true });
await app.register(fastifyFormBody);
await app.register(fastifyWs);

// ── Route 1: Twilio calls this when the phone rings ──────────────────────────
// In Twilio console → Phone Numbers → (361) 315-8772 → set webhook to:
//   https://cafe-pos-production-d0bd.up.railway.app/incoming-call
app.post('/incoming-call', async (req, reply) => {
  const callSid     = req.body.CallSid;
  const callerPhone = req.body.From;

  app.log.info({ callSid, callerPhone }, 'Incoming call');

  if (!isStoreOpen()) {
    app.log.info({ callSid }, 'Store closed — rejecting call');
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, we are currently closed. Our hours are 7 AM to 10 PM daily. Please call back during business hours. Goodbye!</Say>
  <Hangup/>
</Response>`;
    return reply.type('text/xml').send(twiml);
  }

  calls.set(callSid, { callerPhone, order: null, charged: false });

  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// ── Route 2: Bidirectional media stream (Telnyx <-> OpenAI Realtime) ─────────
// Telnyx media streaming uses the same WebSocket protocol as Twilio.
// No changes needed here except the stream event field names (same as Twilio).
app.get('/media-stream', { websocket: true }, (telnyxWs, req) => {
  app.log.info('Media stream connected — waiting for start event');

  const SESSION_CONFIG = {
    model: 'gpt-4o-realtime-preview',
    voice: 'alloy',
    instructions: `You are a friendly phone order-taker for a pizza restaurant. 
Greet the caller and mention the One Pizza Family Deal and Two Pizza Family Deal are each $0.10. 
Take their complete order from this menu: ${MENU_TEXT}. 
Available toppings: Extra Cheese, Pepperoni, Sausage, Onion, Mushroom — all $0.10 each.
Always ask "What would you like to order? Please say your complete order including size and toppings."
IMPORTANT: If the customer orders a pizza without saying small, medium, or large — ask for the size before confirming.
If the customer orders a pop (Coke, Sprite, Mountain Dew) without saying small, medium, or large — ask for the size before confirming.
Confirm the full order including toppings and total, then call the place_order function. Be concise.`,
    input_audio_transcription: { model: 'whisper-1' },
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
    tools: [
      {
        type: 'function',
        name: 'place_order',
        description: 'Call this when the customer has confirmed their complete order including toppings.',
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
  let callSid   = null;

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({ type: 'session.update', session: SESSION_CONFIG }));
  });

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw);

    if (event.type === 'response.audio.delta' && event.delta) {
      telnyxWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
    }

    if (event.type === 'response.function_call_arguments.done' && event.name === 'place_order') {
      const args      = JSON.parse(event.arguments);
      const callState = calls.get(callSid);
      if (callState) callState.order = args;
      const callerPhone = callState?.callerPhone ?? null;
      const result = await chargePhone(callerPhone, callSid, args);
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  telnyxWs.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      // Telnyx sends call_control_id in the start event — use as callSid
      callSid = msg.start.callSid ?? null;
      app.log.info({ callSid, streamSid }, 'Stream started — callSid confirmed');

      if (callSid && !calls.has(callSid)) {
        app.log.warn({ callSid }, 'callSid not in map — call may have arrived out of order');
      }
    }

    if (msg.event === 'media') {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
    }

    if (msg.event === 'stop') openaiWs.close();
  });

  telnyxWs.on('close', () => { openaiWs.close(); });
});

// ── Route 3: Health check ─────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', calls: calls.size }));

// ── Stripe charge by phone number ─────────────────────────────────────────────
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
      amount:         order.total_cents,
      currency:       'usd',
      customer:       customer.id,
      payment_method: pm.id,
      confirm:        true,
      off_session:    true,
      description:    `Pizza order — ${(order.items || []).map(i => `${i.name}x${i.quantity}`).join(', ')}`,
      metadata:       { callSid: callSid || 'unknown', source: 'telnyx-voice-bot' },
    });

    app.log.info({ phone, intentId: intent.id }, 'Payment charged');
    await sendKitchenEmail(order, intent.id, phone);
    await sendSmsReceipt(phone, order, intent.id);

    return {
      success:   true,
      charged:   `$${(order.total_cents / 100).toFixed(2)}`,
      last4:     pm.card.last4,
      receiptId: intent.id,
    };
  } catch (err) {
    app.log.error({ phone, err: err.message }, 'Stripe charge failed');
    return { success: false, error: err.message };
  }
}

// ── Kitchen email via SendGrid ─────────────────────────────────────────────────
async function sendKitchenEmail(order, intentId, phone) {
  const itemRows = (order.items || [])
    .map(i => `
      <tr>
        <td style="padding:6px 12px;">${i.quantity}x ${i.name}</td>
        <td style="padding:6px 12px;text-align:right;">$${((i.price * i.quantity) / 100).toFixed(2)}</td>
      </tr>`)
    .join('');

  const ref   = String(intentId).slice(-8).toUpperCase();
  const total = `$${(order.total_cents / 100).toFixed(2)}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:#e8590c;padding:20px 24px;">
      <h1 style="margin:0;color:#ffffff;font-size:22px;">🍕 New Pizza Order — ${total}</h1>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:2px solid #e8590c;">
            <th style="text-align:left;padding:6px 12px;color:#555;">Item</th>
            <th style="text-align:right;padding:6px 12px;color:#555;">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr style="border-top:2px solid #e8590c;font-weight:bold;">
            <td style="padding:10px 12px;">Total</td>
            <td style="padding:10px 12px;text-align:right;">${total}</td>
          </tr>
        </tfoot>
      </table>
      <div style="margin-top:20px;padding:12px;background:#f9f9f9;border-radius:6px;font-size:14px;color:#444;">
        <div><strong>Phone:</strong> ${phone}</div>
        <div><strong>Ref:</strong> ${ref}</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const plainBody = `NEW PIZZA ORDER\n\n${(order.items || []).map(i => `${i.quantity}x ${i.name} — $${((i.price * i.quantity) / 100).toFixed(2)}`).join('\n')}\n\nTotal: ${total}\nPhone: ${phone}\nRef: ${ref}`;

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'mo40000p@gmail.com' }] }],
        from:     { email: 'orders@svoice.shop', name: 'Pizza Orders' },
        reply_to: { email: 'mo40000p@gmail.com' },
        subject:  `🍕 New Pizza Order — ${total}`,
        content: [
          { type: 'text/plain', value: plainBody },
          { type: 'text/html',  value: htmlBody },
        ],
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

// ── SMS receipt to customer via Telnyx ────────────────────────────────────────
async function sendSmsReceipt(to, order, intentId) {
  const lines = (order.items || []).map(i =>
    `  ${i.name} x${i.quantity}  $${((i.price * i.quantity) / 100).toFixed(2)}`
  );
  const body = [
    'Thanks for your pizza order!',
    ...lines,
    `Total: $${(order.total_cents / 100).toFixed(2)}`,
    `Ref: ${intentId.slice(-8).toUpperCase()}`,
  ].join('\n');

  try {
    await sendTelnyxSms(to, body);
    app.log.info({ to }, 'SMS receipt sent via Telnyx');
  } catch (err) {
    app.log.error({ err: err.message }, 'SMS receipt failed');
  }
}

await app.listen({ port: Number(PORT), host: HOST });
app.log.info(`Server running on port ${PORT}`);
