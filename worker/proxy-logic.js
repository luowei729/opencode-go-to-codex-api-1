// Workers-compatible proxy logic (uses Web Crypto API instead of Node crypto)

// Models that use Anthropic-compatible /v1/messages endpoint
const ANTHROPIC_MODELS = new Set([
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.7-max', 'qwen3.7-plus',
]);

// Default model mapping
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

export function isAnthropicModel(modelName) {
  const clean = modelName.replace(/^opencode-go\//, '');
  return ANTHROPIC_MODELS.has(clean);
}

export function resolveModel(modelName, env) {
  const defaultModel = env.DEFAULT_MODEL;
  if (defaultModel) {
    return defaultModel.replace(/^opencode-go\//, '');
  }

  const modelMapEnv = env.MODEL_MAP || '';
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

export function buildUpstreamUrl(base, path) {
  const baseStr = (base || 'https://opencode.ai/zen/go').replace(/\/+$/, '');
  const pathStr = path.startsWith('/') ? path : '/' + path;
  return baseStr + pathStr;
}

export function normalizeRole(role) {
  if (role === 'developer') return 'system';
  return role;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return part.text || '';
      if (part.type === 'input_image' || part.type === 'input_file') return `[${part.type}]`;
      if (part.type === 'function_call' || part.type === 'function_call_output') return '';
      return part.text || JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text || JSON.stringify(content);
  return String(content);
}

export function convertInputToMessages(input) {
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

export function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const filtered = tools
    .filter(tool => tool.type === 'function' || tool.name)
    .map(tool => {
      if (tool.type === 'function' && tool.function) {
        return tool;
      }
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

export function convertToolsToAnthropic(tools) {
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

export function convertToAnthropicMessages(messages) {
  let system = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : extractContent(msg.content));
      continue;
    }

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
    
    if (role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const parts = [];
      if (content) {
        parts.push({ type: 'text', text: typeof content === 'string' ? content : extractContent(content) });
      }
      for (const tc of msg.tool_calls) {
        parts.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })(),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: parts });
      continue;
    }

    const extracted = typeof content === 'string' ? content : extractContent(content);
    if (extracted) anthropicMessages.push({ role, content: [{ type: 'text', text: extracted }] });
  }

  return { system, messages: anthropicMessages };
}

export function convertRequestToAnthropic(body, resolvedModel) {
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

  const convertedTools = body.tools !== undefined ? convertToolsToAnthropic(body.tools) : undefined;
  if (convertedTools && convertedTools.length > 0) {
    result.tools = convertedTools;

    if (body.tool_choice !== undefined) {
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

function generateHexId(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function convertChatCompletionToResponse(chatResp, originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const choice = chatResp.choices?.[0];
  const message = choice?.message || {};
  const outputText = message.content || '';
  const output = [];

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id || `call_${generateHexId(8)}`,
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

export function convertRequestToChatCompletions(body, resolvedModel) {
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

export function convertAnthropicResponseToResponse(anthResp, originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
  const output = [];
  let textContent = '';

  if (Array.isArray(anthResp.content)) {
    for (const block of anthResp.content) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        output.push({
          type: 'function_call',
          id: block.id || `call_${generateHexId(8)}`,
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

// ---- Stream Converters ----

export function createChatStreamConverter(originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
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

  return {
    process(chunk) {
      const events = [];
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      processEvents(events, parts);
      return events.join('');
    },
    flush() {
      if (!buffer.trim()) return '';
      const events = [];
      processEvents(events, [buffer]);
      buffer = '';
      return events.join('');
    },
  };
}

export function createAnthropicStreamConverter(originalModel) {
  const respId = `resp_${generateHexId(12)}`;
  const msgId = `msg_${generateHexId(12)}`;
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
        if (line.startsWith('data:')) dataStr += line.slice(5).trim();
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

  return {
    process(chunk) {
      const events = [];
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      processAnthropicEvents(events, parts);
      return events.join('');
    },
    flush() {
      if (!buffer.trim()) return '';
      const events = [];
      processAnthropicEvents(events, [buffer]);
      buffer = '';
      return events.join('');
    },
  };
}

export function convertAnthropicToChatCompletion(anthResp, model) {
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
    id: `chatcmpl-${generateHexId(12)}`,
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

export function createAnthropicToChatStreamConverter(model) {
  const respId = `chatcmpl-${generateHexId(8)}`;
  let toolCallIndex = -1;
  let buffer = '';

  function sse(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  function processEvents(events, parts) {
    for (const part of parts) {
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('data:')) dataStr += line.slice(5).trim();
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

  return {
    process(chunk) {
      const events = [];
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      processEvents(events, parts);
      return events.join('');
    },
    flush() {
      if (!buffer.trim()) return '';
      const events = [];
      processEvents(events, [buffer]);
      buffer = '';
      return events.join('');
    },
  };
}

// ---- Upstream Request ----

export async function makeUpstreamRequest(url, body, token, useAnthropic) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (useAnthropic) {
    headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
