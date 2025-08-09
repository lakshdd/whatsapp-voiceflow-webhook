const express = require('express');
const axios = require('axios');
const app = express();

// Environment variables (you'll set these in Railway)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_voiceflow_webhook_2024';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_PROJECT_ID = process.env.VOICEFLOW_PROJECT_ID;

app.use(express.json());

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('✅ Webhook verified!');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Incoming webhook:', JSON.stringify(req.body, null, 2));

    const changes = req.body.entry?.[0]?.changes;
    if (!changes) {
      return res.sendStatus(200);
    }

    for (const change of changes) {
      if (change.field === 'messages') {
        const messages = change.value.messages;
        if (messages) {
          for (const message of messages) {
            await handleMessage(message, change.value);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

// Handle individual messages
async function handleMessage(message, messageData) {
  const from = message.from;
  const messageText = message.text?.body || '';
  const messageType = message.type;

  console.log(`📱 Message from ${from}: ${messageText} (type: ${messageType})`);

  // Skip if not a text message or if it's from us
  if (messageType !== 'text') {
    console.log('⏭️ Skipping non-text message');
    return;
  }

  try {
    // Send message to Voiceflow
    const voiceflowResponse = await sendToVoiceflow(from, messageText);
    
    // Send response back to WhatsApp
    await sendWhatsAppMessage(from, voiceflowResponse);
    
  } catch (error) {
    console.error('❌ Error processing message:', error);
    // Send fallback message
    await sendWhatsAppText(from, "Sorry, I'm having trouble right now. Please try again later.");
  }
}

// Send message to Voiceflow and get response
async function sendToVoiceflow(userId, message) {
  try {
    const response = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
      {
        action: {
          type: 'text',
          payload: message
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${VOICEFLOW_API_KEY}`,
          'Content-Type': 'application/json',
          'versionID': 'production' // or 'development'
        }
      }
    );

    console.log('🤖 Voiceflow response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('❌ Voiceflow API error:', error.response?.data || error.message);
    throw error;
  }
}

// Process Voiceflow response and send to WhatsApp
async function sendWhatsAppMessage(to, voiceflowResponse) {
  const traces = voiceflowResponse.trace || [];
  
  for (const trace of traces) {
    if (trace.type === 'text' && trace.payload?.message) {
      await sendWhatsAppText(to, trace.payload.message);
    } 
    else if (trace.type === 'carousel') {
      await handleCarousel(to, trace.payload);
    }
    else if (trace.type === 'choice') {
      await handleChoiceButtons(to, trace.payload);
    }
  }
}

// Handle carousel - convert to WhatsApp list
async function handleCarousel(to, payload) {
  const cards = payload.cards || [];
  if (cards.length === 0) return;

  // If only one card, send as text with button
  if (cards.length === 1) {
    const card = cards[0];
    let message = `*${card.title}*`;
    if (card.description) {
      message += `\n\n${card.description}`;
    }
    await sendWhatsAppText(to, message);
    return;
  }

  // Multiple cards - create interactive list
  const sections = [{
    title: "Options",
    rows: cards.slice(0, 10).map((card, index) => ({
      id: `option_${index}`,
      title: card.title?.substring(0, 24) || `Option ${index + 1}`,
      description: card.description?.substring(0, 72) || ''
    }))
  }];

  await sendWhatsAppList(to, "Please choose an option:", "Choose", sections);
}

// Handle choice buttons
async function handleChoiceButtons(to, payload) {
  const buttons = payload.buttons || [];
  if (buttons.length === 0) return;

  if (buttons.length <= 3) {
    // Use interactive buttons (max 3)
    const interactiveButtons = buttons.slice(0, 3).map((button, index) => ({
      type: "reply",
      reply: {
        id: `btn_${index}`,
        title: button.name?.substring(0, 20) || `Button ${index + 1}`
      }
    }));

    await sendWhatsAppButtons(to, payload.message || "Choose an option:", interactiveButtons);
  } else {
    // Use list for more than 3 options
    const sections = [{
      title: "Options",
      rows: buttons.slice(0, 10).map((button, index) => ({
        id: `choice_${index}`,
        title: button.name?.substring(0, 24) || `Option ${index + 1}`,
        description: button.request?.payload?.intent?.name || ''
      }))
    }];

    await sendWhatsAppList(to, payload.message || "Please choose an option:", "Choose", sections);
  }
}

// Send WhatsApp text message
async function sendWhatsAppText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Text message sent');
  } catch (error) {
    console.error('❌ Failed to send text:', error.response?.data || error.message);
  }
}

// Send WhatsApp interactive buttons
async function sendWhatsAppButtons(to, text, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: text },
          action: { buttons: buttons }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Button message sent');
  } catch (error) {
    console.error('❌ Failed to send buttons:', error.response?.data || error.message);
  }
}

// Send WhatsApp list message
async function sendWhatsAppList(to, text, buttonText, sections) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: text },
          action: {
            button: buttonText,
            sections: sections
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ List message sent');
  } catch (error) {
    console.error('❌ Failed to send list:', error.response?.data || error.message);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'WhatsApp Voiceflow Webhook is running! 🚀',
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('📱 WhatsApp Voiceflow Webhook ready!');
});

module.exports = app;
