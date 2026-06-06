require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createResponsesProxyHandler, createChatCompletionsProxyHandler, getRuntimeDefaultModel, setRuntimeDefaultModel, isAnthropicModel } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 30001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// List models endpoint
app.get('/v1/models', async (req, res) => {
  try {
    const upstream = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
    const token = process.env.OPENCODE_TOKEN || req.headers.authorization?.replace('Bearer ', '');

    const response = await fetch(`${upstream}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching models:', err.message);
    res.status(502).json({ error: { message: 'Failed to fetch models from upstream' } });
  }
});

// API: Get current runtime default model
app.get('/api/default-model', (req, res) => {
  res.json({
    runtimeDefault: getRuntimeDefaultModel(),
    envDefault: process.env.DEFAULT_MODEL || null,
  });
});

// API: Set runtime default model
app.post('/api/default-model', (req, res) => {
  const { model } = req.body;
  if (model === null || model === '' || model === undefined) {
    setRuntimeDefaultModel(null);
    return res.json({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  setRuntimeDefaultModel(model);
  return res.json({ success: true, model, message: `已强制使用模型: ${model}` });
});

// Web UI - serve static HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Responses API -> Chat Completions / Anthropic Messages conversion
app.post('/v1/responses', createResponsesProxyHandler());

// Chat Completions API -> upstream (with model resolution and Anthropic conversion)
app.post('/v1/chat/completions', createChatCompletionsProxyHandler());

// Proxy other /v1/* requests
app.all('/v1/*', (req, res) => {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenCode Go -> Codex API proxy running on port ${PORT}`);
  console.log(`Upstream: ${process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go'}`);
  console.log(`Default model: ${process.env.DEFAULT_MODEL || '(use client model)'}`);
  console.log(`Auth token: ${process.env.OPENCODE_TOKEN ? '***configured***' : '(passthrough from client)'}`);
  console.log(`Web UI: http://127.0.0.1:${PORT}/`);
});
