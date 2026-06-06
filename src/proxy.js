const crypto = require('crypto');

// Runtime default model (can be changed via web UI without restart)
let runtimeDefaultModel = null;

// Models that use the Anthropic-compatible /v1/messages endpoint (NOT OpenAI compatible)
const ANTHROPIC_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus',
]);

// Default model mapping: Codex/OpenAI model names -> OpenCode Go model names
const DEFAULT_MODEL_MAP = {
  'gpt-5.5': 'qwen3.7-max',
  'gpt-5': 'qwen3.7-max',
  'gpt-5.4': 'qwen3.7-plus',
  'gpt-5.4-mini': 'qwen3.7-plus',
  'gpt-4': 'kimi-k2.6',
  'gpt-4o': 'kimi-k2.6',
  'gpt-4o-mini': 'deepseek-v4-flash',
  'o3': 'qwen3.7-max',
  'o4-mini': 'deepseek-v4-flash',
  'o3-mini': 'deepseek-v4-flash',
};

function isAnthropicModel(modelName) {
  const clean = modelName.replace(/^opencode-go\//, '');
  return ANTHROPIC_MODELS.has(clean);
}

function getRuntimeDefaultModel() {
  return runtimeDefaultModel;
}

function setRuntimeDefaultModel(model) {
  runtimeDefaultModel = model || null;
}

// Resolve model name: runtime > env DEFAULT_MODEL > env MODEL_MAP > built-in map > passthrough
function resolveModel(modelName) {
  // 1. Runtime default (set via web UI)
  if (runtimeDefaultModel) {
    return runtimeDefaultModel.replace(/^opencode-go\//, '');
  }

  // 2. Env DEFAULT_MODEL
  if (process.env.DEFAULT_MODEL) {
    return process.env.DEFAULT_MODEL.replace(/^opencode-go\//, '');
  }

  const modelMapEnv = process.env.MODEL_MAP || '';
  if (modelMapEnv) {
    const pairs = modelMapEnv.split(',');
    for (const pair of pairs) {
      const [from, to] = pair.split(':');
      if (from?.trim() && to?.trim() && modelName === from.trim()) {
        return to.trim().replace(/^opencode-go\//, '');
      }
    }
  }

  if (DEFAULT_MODEL_MAP[modelName]) {
    return DEFAULT_MODEL_MAP[modelName];
  }

  return modelName.replace(/^opencode-go\//, '');
}

function buildUpstreamUrl(base, path) {
  const baseStr = (base || 'https://opencode.ai/zen/go').replace(/\/+$/, '');
  const pathStr = path.startsWith('/') ? path : '/' + path;
  return baseStr + pathStr;
}

// Normalize message roles: map 'developer' -> 'system' (not supported by most providers)
function normalizeRole(role) {
  if (role === 'developer') return 'system';
  return role;
}

function convertInputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) {
    return [{ role: 'user', content: JSON.stringify(input) }];
  }

  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    
    // Handle function_call type (tool calls from assistant)
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments || '{}',
          },
        }],
      });
      continue;
    }
    
    // Handle function_call_output type (tool results)
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: item.output || '',
      });
      continue;
    }
    
    if (item.type === 'message' || item.role) {
      const role = normalizeRole(item.role || 'user');
      const content = item.content;
      
      // Handle content arrays that may contain function_call or function_call_output blocks
      if (Array.isArray(content)) {
        const textParts = [];
        const toolMessages = [];
        
        for (const part of content) {
          if (typeof part === 'string') {
            textParts.push(part);
          } else if (part.type === 'function_call') {
            toolMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: part.call_id || part.id,
                type: 'function',
                function: { name: part.name, arguments: part.arguments || '{}' },
              }],
            });
          } else if (part.type === 'function_call_output') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: part.call_id || part.id,
              content: part.output || '',
            });
          } else if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
            textParts.push(part.text || '');
          } else if (part.type === 'tool_use') {
            toolMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: part.call_id || part.id,
                type: 'function',
                function: { name: part.name, arguments: part.arguments || '{}' },
              }],
            });
          } else if (part.type === 'tool_result') {
            toolMessages.push({
              role: 'tool',
              tool_call_id: part.tool_use_id || part.call_id || part.id,
              content: part.content || '',
            });
          }
        }
        
        const textContent = textParts.filter(Boolean).join('\n');
        if (textContent) messages.push({ role, content: textContent });
        messages.push(...toolMessages);
      } else {
        const extracted = extractContent(content);
        if (extracted) messages.push({ role, content: extracted });
      }
      continue;
    }
    if (item.content) {
      messages.push({ role: normalizeRole(item.role || 'user'), content: extractContent(item.content) });
    }
  }
  return messages;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return part.text || '';
      if (part.type === 'input_image' || part.type === 'input_file') return `[${part.type}]`;
      // Skip function_call and function_call_output content blocks (handled separately)
      if (part.type === 'function_call' || part.type === 'function_call_output') return '';
      return part.text || JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  // Only keep function-type tools; filter out non-function tools (web_search, etc.)
  const filtered = tools
    .filter(tool => tool.type === 'function' || tool.name)
    .map(tool => {
      if (tool.type === 'function' && tool.function) {
        // Standard Chat Completions format - pass through
        return tool;
      }
      // Responses API format: name/parameters at top level -> convert to function wrapper
      return {
        type: 'function',
        function: {
          name: tool.name || tool.function?.name,
          description: tool.description || tool.function?.description || '',
          parameters: tool.parameters || tool.function?.parameters || { type: 'object', properties: {} },
        },
      };
    });
  return filtered.length > 0 ? filtered : undefined;
}

function convertToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(tool => {
    if (tool.type === 'function') {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || { type: 'object', properties: {} },
      };
    }
    if (tool.name) {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      };
    }
    return tool;
  });
}

function convertToAnthropicMessages(messages) {
  let system = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : extractContent(msg.content));
      continue;
    }

    // Handle tool role (tool results) - Anthropic expects these as user messages with tool_result
    if (msg.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || msg.id,
          content: msg.content || '',
        }],
      });
      continue;
    }

    let role = msg.role;
    let content = msg.content;
    
    // Handle assistant messages with tool_calls
    if (role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const parts = [];
      if (content) {
        parts.push({ type: 'text', text: typeof content === 'string' ? content : extractContent(content) });
      }
      for (const tc of msg.tool_calls) {
        parts.push({
          type: 'tool_use',
          id: tc.id || tc.call_id,
          name: tc.function?.name || tc.name,
          input: JSON.parse(tc.function?.arguments || '{}'),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: parts });
      continue;
    }
    
    if (typeof content === 'string') {
      anthropicMessages.push({ role, content });
    } else if (Array.isArray(content)) {
      const parts = content.map(part => {
        if (typeof part === 'string') return { type: 'text', text: part };
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return { type: 'text', text: part.text || '' };
        }
        if (part.type === 'tool_use') {
          return { type: 'tool_use', id: part.id || part.call_id, name: part.name, input: JSON.parse(part.arguments || '{}') };
        }
        if (part.type === 'tool_result') {
          return { type: 'tool_result', tool_use_id: part.tool_use_id || part.call_id, content: part.content || '' };
        }
        return { type: 'text', text: JSON.stringify(part) };
      });
      anthropicMessages.push({ role, content: parts });
    } else {
      anthropicMessages.push({ role, content: extractContent(content) });
    }
  }

  return { system, messages: anthropicMessages };
}

function convertRequestToChatCompletions(body, resolvedModel) {
  const result = {
    model: resolvedModel,
    stream: body.stream || false,
  };

  if (body.input) {
    result.messages = convertInputToMessages(body.input);
  } else if (body.messages) {
    result.messages = body.messages;
  }

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.frequency_penalty !== undefined) result.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) result.presence_penalty = body.presence_penalty;
  if (body.stop !== undefined) result.stop = body.stop;
  if (body.tools !== undefined) result.tools = convertTools(body.tools);
  if (body.tool_choice !== undefined) {
    // Convert Responses API tool_choice to Chat Completions format
    if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required') {
      result.tool_choice = body.tool_choice;
    } else if (typeof body.tool_choice === 'object' && body.tool_choice.function) {
      result.tool_choice = body.tool_choice;
    } else if (typeof body.tool_choice === 'object' && body.tool_choice.name) {
      result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  return result;
}

function convertRequestToAnthropic(body, resolvedModel) {
  let messages = [];
  if (body.input) {
    messages = convertInputToMessages(body.input);
  } else if (body.messages) {
    messages = body.messages;
  }

  const { system, messages: anthropicMessages } = convertToAnthropicMessages(messages);

  const result = {
    model: resolvedModel,
    stream: body.stream || false,
    max_tokens: body.max_output_tokens || body.max_tokens || 64000,
    messages: anthropicMessages,
  };

  if (system) result.system = system;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // Only include tools if defined AND non-empty
  // Upstream returns 500 if tool_choice is sent without tools
  const convertedTools = body.tools !== undefined ? convertToolsToAnthropic(body.tools) : undefined;
  if (convertedTools && convertedTools.length > 0) {
    result.tools = convertedTools;

    // Only include tool_choice if tools are present
    if (body.tool_choice !== undefined) {
      // Convert to Anthropic tool_choice format
      if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
      else if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
      else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
      else if (typeof body.tool_choice === 'object' && body.tool_choice.name) {
        result.tool_choice = { type: 'tool', name: body.tool_choice.name };
      }
    }
  }

  return result;
}

function convertChatCompletionToResponse(chatResp, originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const choice = chatResp.choices?.[0];
  const message = choice?.message || {};
  const outputText = message.content || '';
  const output = [];

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`,
        call_id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      });
    }
  }

  output.push({
    type: 'message',
    id: msgId,
    role: 'assistant',
    content: [{ type: 'output_text', text: outputText, annotations: [] }],
  });

  const usage = chatResp.usage || {};
  return {
    id: respId,
    object: 'response',
    created_at: chatResp.created || Math.floor(Date.now() / 1000),
    model: originalModel,
    status: 'completed',
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  };
}

function convertAnthropicResponseToResponse(anthResp, originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const output = [];
  let textContent = '';

  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        output.push({
          type: 'function_call',
          id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
          call_id: block.id,
          name: block.name || '',
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }
  }

  output.push({
    type: 'message',
    id: msgId,
    role: 'assistant',
    content: [{ type: 'output_text', text: textContent, annotations: [] }],
  });

  const usage = anthResp.usage || {};
  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: originalModel,
    status: 'completed',
    output,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

function createChatStreamConverter(originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let headersSent = false;
  let toolCalls = [];
  let buffer = '';

  function buildBaseResponse(status) {
    const resp = {
      id: respId, object: 'response', created_at: createdAt, model: originalModel,
      output: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
    if (status) resp.status = status;
    return resp;
  }

  function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function processEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) {
          dataStr += line.slice(5).trim();
        }
      }
      if (!dataStr) continue;

      if (dataStr === '[DONE]') {
        events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText }));
        events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));

        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } }));
          events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } }));
        }

        events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }));

        const finalResp = buildBaseResponse('completed');
        for (const tc of toolCalls) {
          finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
        }
        finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
        events.push(sse('response.completed', { type: 'response.completed', response: finalResp }));
        continue;
      }

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || inputTokens;
          outputTokens = parsed.usage.completion_tokens || outputTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (delta.role && !headersSent) {
          headersSent = true;
          events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') }));
          events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } }));
          events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
          }
          continue;
        }

        if (delta.content) {
          fullText += delta.content;
          events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.content }));
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

function createAnthropicStreamConverter(originalModel) {
  const respId = `resp_${crypto.randomBytes(12).toString('hex')}`;
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let headersSent = false;
  let toolCalls = [];
  let currentToolIndex = -1;
  let buffer = '';

  function buildBaseResponse(status) {
    const resp = {
      id: respId, object: 'response', created_at: createdAt, model: originalModel,
      output: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
    if (status) resp.status = status;
    return resp;
  }

  function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function processAnthropicEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) {
          dataStr += line.slice(5).trim();
        }
      }
      if (!dataStr || dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;

        if (eventType === 'message_start') {
          const msg = parsed.message || {};
          inputTokens = msg.usage?.input_tokens || 0;
          if (!headersSent) {
            headersSent = true;
            events.push(sse('response.created', { type: 'response.created', response: buildBaseResponse('in_progress') }));
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } }));
            events.push(sse('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
          }
        } else if (eventType === 'content_block_start') {
          const block = parsed.content_block || {};
          if (block.type === 'tool_use') {
            currentToolIndex = toolCalls.length;
            toolCalls.push({ id: block.id || '', name: block.name || '', arguments: '' });
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: currentToolIndex + 1, item: { type: 'function_call', id: block.id || '', call_id: block.id || '', name: block.name || '', arguments: '' } }));
          }
        } else if (eventType === 'content_block_delta') {
          const delta = parsed.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            fullText += delta.text;
            events.push(sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.text }));
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            if (currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
              toolCalls[currentToolIndex].arguments += delta.partial_json;
            }
          }
        } else if (eventType === 'message_delta') {
          outputTokens = parsed.usage?.output_tokens || 0;
        } else if (eventType === 'message_stop') {
          events.push(sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText }));
          events.push(sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } }));

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: '' } }));
            events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: { type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments } }));
          }

          events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } }));

          const finalResp = buildBaseResponse('completed');
          for (const tc of toolCalls) {
            finalResp.output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments });
          }
          finalResp.output.push({ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] });
          events.push(sse('response.completed', { type: 'response.completed', response: finalResp }));
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processAnthropicEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processAnthropicEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

async function makeUpstreamRequest(url, body, token, useAnthropic) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (useAnthropic) {
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const bodyStr = JSON.stringify(body);

  // Add timeout for connection establishment (5 minutes for long-running requests)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function createResponsesProxyHandler() {
  return async (req, res) => {
    try {
      const upstreamBase = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
      const token = process.env.OPENCODE_TOKEN || req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({ error: { message: 'No authentication token provided.', type: 'authentication_error' } });
      }

      const originalModel = req.body?.model || 'unknown';
      const resolvedModel = resolveModel(originalModel);
      const isStream = req.body?.stream === true;
      const useAnthropic = isAnthropicModel(resolvedModel);

      let upstreamBody;
      let upstreamPath;

      if (useAnthropic) {
        upstreamBody = convertRequestToAnthropic(req.body, resolvedModel);
        upstreamPath = '/v1/messages';
      } else {
        upstreamBody = convertRequestToChatCompletions(req.body, resolvedModel);
        upstreamPath = '/v1/chat/completions';
      }

      const upstreamUrl = buildUpstreamUrl(upstreamBase, upstreamPath);
      console.log(`[${new Date().toISOString()}] POST /v1/responses -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, stream: ${isStream}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

      const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
        try {
          const errorJson = JSON.parse(errorText);
          return res.status(response.status).json(errorJson);
        } catch {
          return res.status(response.status).json({ error: { message: `Upstream error: ${response.status} ${errorText.substring(0, 200)}`, type: 'upstream_error' } });
        }
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const converter = useAnthropic
          ? createAnthropicStreamConverter(originalModel)
          : createChatStreamConverter(originalModel);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const converted = converter(chunk);
            if (converted) res.write(converted);
          }
          // Flush any remaining buffered data
          const remaining = converter.flush();
          if (remaining) res.write(remaining);
        } catch (streamErr) {
          console.error('Stream read error:', streamErr.message);
          // Send error event to client instead of silently ending stream
          if (!res.writableEnded) {
            const errorEvent = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'error', status: 'failed', error: { message: streamErr.message } } })}\n\n`;
            res.write(errorEvent);
          }
        }
        res.end();
      } else {
        const data = await response.text();
        try {
          const upstreamResp = JSON.parse(data);
          if (upstreamResp.error) {
            return res.status(response.status || 500).json(upstreamResp);
          }
          if (useAnthropic) {
            res.json(convertAnthropicResponseToResponse(upstreamResp, originalModel));
          } else {
            res.json(convertChatCompletionToResponse(upstreamResp, originalModel));
          }
        } catch (e) {
          console.error('Response parse error:', e.message, 'Raw:', data.substring(0, 500));
          res.status(502).json({ error: { message: 'Failed to parse upstream response', type: 'server_error' } });
        }
      }

    } catch (err) {
      console.error('Proxy handler error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${err.message}`, type: 'proxy_error' } });
      else res.end();
    }
  };
}

function convertAnthropicToChatCompletion(anthResp, model) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];

  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') {
        message.content += block.text || '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = anthResp.usage || {};
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message,
      finish_reason: anthResp.stop_reason === 'end_turn' ? 'stop' : (anthResp.stop_reason === 'tool_use' ? 'tool_calls' : anthResp.stop_reason || 'stop'),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

function createAnthropicToChatStreamConverter(model) {
  const respId = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  let toolCallIndex = -1;
  let buffer = '';

  function sse(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  function processAnthropicToChatEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) {
          dataStr += line.slice(5).trim();
        }
      }
      if (!dataStr) continue;

      try {
        const parsed = JSON.parse(dataStr);
        const eventType = parsed.type;

        if (eventType === 'message_start') {
          events.push(sse({
            id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          }));
        } else if (eventType === 'content_block_start') {
          const block = parsed.content_block || {};
          if (block.type === 'tool_use') {
            toolCallIndex++;
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }],
            }));
          }
        } else if (eventType === 'content_block_delta') {
          const delta = parsed.delta || {};
          if (delta.type === 'text_delta' && delta.text) {
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
            }));
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, function: { arguments: delta.partial_json } }] }, finish_reason: null }],
            }));
          }
        } else if (eventType === 'message_delta') {
          const stopReason = parsed.delta?.stop_reason;
          if (stopReason) {
            const finishReason = stopReason === 'end_turn' ? 'stop' : (stopReason === 'tool_use' ? 'tool_calls' : stopReason);
            events.push(sse({
              id: respId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }));
          }
        }
      } catch (e) { /* skip malformed */ }
    }
  }

  function processChunk(chunk) {
    const events = [];
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    processAnthropicToChatEvents(events, parts);
    return events.join('');
  }

  processChunk.flush = function() {
    if (!buffer.trim()) return '';
    const events = [];
    processAnthropicToChatEvents(events, [buffer]);
    buffer = '';
    return events.join('');
  };

  return processChunk;
}

function createChatCompletionsProxyHandler() {
  return async (req, res) => {
    try {
      const upstreamBase = process.env.UPSTREAM_BASE_URL || 'https://opencode.ai/zen/go';
      const token = process.env.OPENCODE_TOKEN || req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({ error: { message: 'No auth token', type: 'authentication_error' } });
      }

      const originalModel = req.body?.model || 'gpt-4o';
      const resolvedModel = resolveModel(originalModel);
      req.body.model = resolvedModel;

      const useAnthropic = isAnthropicModel(resolvedModel);
      let upstreamBody;
      let upstreamPath;

      if (useAnthropic) {
        const pseudoResponsesBody = {
          model: resolvedModel,
          messages: req.body.messages,
          stream: req.body.stream || false,
          max_output_tokens: req.body.max_tokens || 64000,
          temperature: req.body.temperature,
          top_p: req.body.top_p,
          stop: req.body.stop,
          tools: req.body.tools,
        };
        upstreamBody = convertRequestToAnthropic(pseudoResponsesBody, resolvedModel);
        upstreamPath = '/v1/messages';
      } else {
        upstreamBody = { ...req.body };
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
      const isStream = req.body?.stream === true;

      console.log(`[${new Date().toISOString()}] POST /v1/chat/completions -> ${upstreamUrl} (model: ${originalModel} -> ${resolvedModel}, api: ${useAnthropic ? 'anthropic' : 'openai'})`);

      const response = await makeUpstreamRequest(upstreamUrl, upstreamBody, token, useAnthropic);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Upstream error ${response.status}: ${errorText.substring(0, 500)}`);
        try {
          const errorJson = JSON.parse(errorText);
          return res.status(response.status).json(errorJson);
        } catch {
          return res.status(response.status).json({ error: { message: `Upstream error: ${response.status}`, type: 'upstream_error' } });
        }
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        if (useAnthropic) {
          const converter = createAnthropicToChatStreamConverter(resolvedModel);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              const converted = converter(chunk);
              if (converted) res.write(converted);
            }
            const remaining = converter.flush();
            if (remaining) res.write(remaining);
          } catch (streamErr) {
            console.error('Stream read error:', streamErr.message);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(decoder.decode(value, { stream: true }));
            }
          } catch (streamErr) {
            console.error('Stream read error:', streamErr.message);
          }
          res.end();
        }
      } else {
        const data = await response.text();
        try {
          const upstreamResp = JSON.parse(data);
          if (useAnthropic) {
            res.json(convertAnthropicToChatCompletion(upstreamResp, resolvedModel));
          } else {
            res.json(upstreamResp);
          }
        } catch {
          res.send(data);
        }
      }

    } catch (err) {
      console.error('Chat handler error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: 'proxy_error' } });
      else res.end();
    }
  };
}

module.exports = { createResponsesProxyHandler, createChatCompletionsProxyHandler, getRuntimeDefaultModel, setRuntimeDefaultModel, isAnthropicModel };
