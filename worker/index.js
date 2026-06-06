import {
  isAnthropicModel,
  resolveModel,
  buildUpstreamUrl,
  normalizeRole,
  convertInputToMessages,
  convertTools,
  convertRequestToChatCompletions,
  convertRequestToAnthropic,
  convertChatCompletionToResponse,
  convertAnthropicResponseToResponse,
  convertAnthropicToChatCompletion,
  createChatStreamConverter,
  createAnthropicStreamConverter,
  createAnthropicToChatStreamConverter,
  makeUpstreamRequest,
} from './proxy-logic.js';

import indexHtml from '../pages/index.html';

// Runtime default model (note: resets on each isolate restart in Workers)
let runtimeDefaultModel = null;

function resolveModelWithRuntime(modelName, env) {
  // 1. Runtime default (set via web UI - ephemeral in Workers)
  if (runtimeDefaultModel) {
    return runtimeDefaultModel.replace(/^opencode-go\//, '');
  }
  return resolveModel(modelName, env);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

// ---- Route Handlers ----

async function handleHealth() {
  return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

async function handleModels(authHeader) {
  try {
    const upstream = 'https://opencode.ai/zen/go';
    const token = authHeader?.replace('Bearer ', '');

    const response = await fetch(`${upstream}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return jsonResponse(data);
  } catch (err) {
    console.error('Error fetching models:', err.message);
    return jsonResponse({ error: { message: 'Failed to fetch models from upstream' } }, 502);
  }
}

async function handleGetDefaultModel(env) {
  return jsonResponse({
    runtimeDefault: runtimeDefaultModel,
    envDefault: env.DEFAULT_MODEL || null,
  });
}

async function handleSetDefaultModel(request) {
  const body = await request.json();
  const { model } = body;
  if (model === null || model === '' || model === undefined) {
    runtimeDefaultModel = null;
    return jsonResponse({ success: true, model: null, message: '已取消强制模型，使用客户端传入的模型' });
  }
  runtimeDefaultModel = model;
  return jsonResponse({ success: true, model, message: `已强制使用模型: ${model}` });
}

async function handleResponses(request, env) {
  try {
    const upstreamBase = env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
    const token = request.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) {
      return jsonResponse({ error: { message: 'No authentication token provided. Please send your OpenCode Go token via Authorization header.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'unknown';
    const resolvedModel = resolveModelWithRuntime(originalModel, env);
    const isStream = reqBody?.stream === true;
    const useAnthropic = isAnthropicModel(resolvedModel);

    let upstreamBody;
    let upstreamPath;

    if (useAnthropic) {
      upstreamBody = convertRequestToAnthropic(reqBody, resolvedModel);
      upstreamPath = '/v1/messages';
    } else {
      upstreamBody = convertRequestToChatCompletions(reqBody, resolvedModel);
      upstreamPath = '/v1/chat/completions';
    }

    const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
    console.log(`[Responses] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      try {
        return jsonResponse(JSON.parse(errorText), response.status);
      } catch {
        return jsonResponse({ error: { message: `Upstream error: ${response.status} ${errorText.substring(0, 200)}`, type: 'upstream_error' } }, response.status);
      }
    }

    if (isStream) {
      const converter = useAnthropic
        ? createAnthropicStreamConverter(originalModel)
        : createChatStreamConverter(originalModel);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              const remaining = converter.flush();
              if (remaining) controller.enqueue(new TextEncoder().encode(remaining));
              controller.close();
              return;
            }
            const chunk = decoder.decode(value, { stream: true });
            const converted = converter.process(chunk);
            if (converted) controller.enqueue(new TextEncoder().encode(converted));
          } catch (streamErr) {
            console.error('Stream read error:', streamErr.message);
            const errorEvent = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'error', status: 'failed', error: { message: streamErr.message } } })}\n\n`;
            controller.enqueue(new TextEncoder().encode(errorEvent));
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...corsHeaders(),
        },
      });
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        if (upstreamResp.error) {
          return jsonResponse(upstreamResp, response.status || 500);
        }
        if (useAnthropic) {
          return jsonResponse(convertAnthropicResponseToResponse(upstreamResp, originalModel));
        } else {
          return jsonResponse(convertChatCompletionToResponse(upstreamResp, originalModel));
        }
      } catch (e) {
        console.error('Response parse error:', e.message);
        return jsonResponse({ error: { message: 'Failed to parse upstream response', type: 'server_error' } }, 502);
      }
    }
  } catch (err) {
    console.error('Proxy handler error:', err.message);
    return jsonResponse({ error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } }, 502);
  }
}

async function handleChatCompletions(request, env) {
  try {
    const upstreamBase = env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
    const token = request.headers.get('authorization')?.replace('Bearer ', '');

    if (!token) {
      return jsonResponse({ error: { message: 'No auth token. Please send your OpenCode Go token via Authorization header.', type: 'authentication_error' } }, 401);
    }

    const reqBody = await request.json();
    const originalModel = reqBody?.model || 'gpt-4o';
    const resolvedModel = resolveModelWithRuntime(originalModel, env);
    reqBody.model = resolvedModel;

    const useAnthropic = isAnthropicModel(resolvedModel);
    let upstreamBody;
    let upstreamPath;

    if (useAnthropic) {
      const pseudoResponsesBody = {
        model: resolvedModel,
        messages: reqBody.messages,
        stream: reqBody.stream || false,
        max_output_tokens: reqBody.max_tokens || 64000,
        temperature: reqBody.temperature,
        top_p: reqBody.top_p,
        stop: reqBody.stop,
        tools: reqBody.tools,
      };
      upstreamBody = convertRequestToAnthropic(pseudoResponsesBody, resolvedModel);
      upstreamPath = '/v1/messages';
    } else {
      upstreamBody = { ...reqBody };
      if (Array.isArray(upstreamBody.messages)) {
        upstreamBody.messages = upstreamBody.messages.map(m => ({
          ...m,
          role: normalizeRole(m.role),
        }));
      }
      if (upstreamBody.tools) {
        upstreamBody.tools = convertTools(upstreamBody.tools);
      }
      upstreamPath = '/v1/chat/completions';
    }

    const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
    const isStream = reqBody?.stream === true;

    console.log(`[Chat] -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

    const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
      try {
        return jsonResponse(JSON.parse(errorText), response.status);
      } catch {
        return jsonResponse({ error: { message: `Upstream error: ${response.status}`, type: 'upstream_error' } }, response.status);
      }
    }

    if (isStream) {
      if (useAnthropic) {
        const converter = createAnthropicToChatStreamConverter(resolvedModel);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                const remaining = converter.flush();
                if (remaining) controller.enqueue(new TextEncoder().encode(remaining));
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
                return;
              }
              const chunk = decoder.decode(value, { stream: true });
              const converted = converter.process(chunk);
              if (converted) controller.enqueue(new TextEncoder().encode(converted));
            } catch (streamErr) {
              console.error('Stream read error:', streamErr.message);
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      } else {
        // Pass through OpenAI stream directly
        return new Response(response.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      }
    } else {
      const data = await response.text();
      try {
        const upstreamResp = JSON.parse(data);
        if (useAnthropic) {
          return jsonResponse(convertAnthropicToChatCompletion(upstreamResp, resolvedModel));
        } else {
          return jsonResponse(upstreamResp);
        }
      } catch {
        return new Response(data, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }
  } catch (err) {
    console.error('Chat handler error:', err.message);
    return jsonResponse({ error: { message: err.message, type: 'proxy_error' } }, 502);
  }
}

// ---- Main Fetch Handler ----

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // API Routes
    if (path === '/health' && request.method === 'GET') {
      return handleHealth();
    }

    if (path === '/v1/models' && request.method === 'GET') {
      return handleModels(request.headers.get('authorization'));
    }

    if (path === '/api/default-model' && request.method === 'GET') {
      return handleGetDefaultModel(env);
    }

    if (path === '/api/default-model' && request.method === 'POST') {
      return handleSetDefaultModel(request);
    }

    if (path === '/v1/responses' && request.method === 'POST') {
      return handleResponses(request, env);
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    // For /v1/* routes that don't match, return 404
    if (path.startsWith('/v1/')) {
      return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
    }

    // Serve index.html for root and other non-API routes
    if (path === '/' || path === '/index.html' || path === '/favicon.ico') {
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }
      return new Response(indexHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
      });
    }

    return jsonResponse({ error: { message: `Route ${request.method} ${path} not found` } }, 404);
  },
};
