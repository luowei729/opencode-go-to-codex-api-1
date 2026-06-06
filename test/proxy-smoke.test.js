const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function writeSse(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  for (const event of events) {
    res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function createUpstream() {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }

      const body = await readJson(req);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url === '/v1/chat/completions') {
        if (body.stream) {
          writeSse(res, [
            { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_openai_1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"codex"}' },
                  }],
                },
                finish_reason: null,
              }],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ]);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-openai',
            object: 'chat.completion',
            created: 1710000000,
            model: body.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'OpenAI-compatible answer',
                tool_calls: [{
                  id: 'call_openai_nonstream',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"codex"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
          }));
        }
        return;
      }

      if (req.url === '/v1/messages') {
        if (body.stream) {
          writeSse(res, [
            { type: 'message_start', message: { usage: { input_tokens: 7 } } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Anthropic' } },
            { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
            { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"codex"}' } },
            { type: 'message_delta', usage: { output_tokens: 9 }, delta: { stop_reason: 'tool_use' } },
            { type: 'message_stop' },
          ]);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_anthropic',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [
              { type: 'text', text: 'Anthropic answer' },
              { type: 'tool_use', id: 'toolu_nonstream', name: 'lookup', input: { q: 'codex' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 4, output_tokens: 6 },
          }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });

  return { server, requests };
}

async function startProxy(upstreamPort) {
  const proxyServer = http.createServer();
  const proxyPort = await listen(proxyServer);
  proxyServer.close();

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(proxyPort),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENCODE_TOKEN: 'test-token',
      DEFAULT_MODEL: '',
      MODEL_MAP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (resp.ok) {
        return {
          port: proxyPort,
          stop: async () => {
            child.kill('SIGTERM');
            await Promise.race([
              once(child, 'exit'),
              new Promise(resolve => setTimeout(resolve, 1000)),
            ]);
          },
          logs: () => ({ stdout, stderr }),
        };
      }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  child.kill('SIGTERM');
  throw new Error(`proxy did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function postJson(baseUrl, path, body) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-token' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  return JSON.parse(text);
}

async function postSse(baseUrl, path, body) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-token' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  return text;
}

function sseEventCount(text, eventName) {
  return (text.match(new RegExp(`event: ${eventName}`, 'g')) || []).length;
}

function jsonPayloads(text) {
  return text
    .split('\n\n')
    .map(part => part.split('\n').find(line => line.startsWith('data: '))?.slice(6))
    .filter(Boolean)
    .filter(data => data !== '[DONE]')
    .map(data => JSON.parse(data));
}

test('proxy supports OpenAI-compatible and Anthropic-compatible upstream modes', async t => {
  const upstream = createUpstream();
  const upstreamPort = await listen(upstream.server);
  const proxy = await startProxy(upstreamPort);
  const baseUrl = `http://127.0.0.1:${proxy.port}`;

  t.after(async () => {
    await proxy.stop();
    upstream.server.close();
  });

  await t.test('Responses API -> OpenAI chat completion, non-stream', async () => {
    const response = await postJson(baseUrl, '/v1/responses', {
      model: 'gpt-4o',
      input: 'hello',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
      stream: false,
    });

    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.equal(response.output[0].type, 'function_call');
    assert.equal(response.output.at(-1).content[0].text, 'OpenAI-compatible answer');

    const request = upstream.requests.at(-1);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    assert.equal(request.body.model, 'kimi-k2.6');
    assert.equal(request.body.messages[0].role, 'user');
    assert.equal(request.body.tools[0].type, 'function');
  });

  await t.test('Responses API -> OpenAI chat completion, stream', async () => {
    const text = await postSse(baseUrl, '/v1/responses', {
      model: 'gpt-4o',
      input: 'stream',
      stream: true,
    });

    assert.equal(sseEventCount(text, 'response.completed'), 1);
    assert.equal(sseEventCount(text, 'response.failed'), 0);
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /event: response.output_item.done/);
  });

  await t.test('Responses API -> Anthropic messages, non-stream', async () => {
    const response = await postJson(baseUrl, '/v1/responses', {
      model: 'qwen3.7-max',
      input: [
        { role: 'developer', content: 'system instruction' },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }],
      stream: false,
    });

    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.equal(response.output[0].type, 'function_call');
    assert.equal(response.output.at(-1).content[0].text, 'Anthropic answer');

    const request = upstream.requests.at(-1);
    assert.equal(request.url, '/v1/messages');
    // Upstream proxy authenticates via Bearer, not x-api-key
    assert.equal(request.headers.authorization, 'Bearer test-token');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body.model, 'qwen3.7-max');
    assert.equal(request.body.system, 'system instruction');
    assert.equal(request.body.messages[0].role, 'user');
    assert.equal(request.body.tools[0].input_schema.type, 'object');
  });

  await t.test('Responses API -> Anthropic messages, stream', async () => {
    const text = await postSse(baseUrl, '/v1/responses', {
      model: 'qwen3.7-max',
      input: 'stream',
      stream: true,
    });

    assert.equal(sseEventCount(text, 'response.completed'), 1);
    assert.equal(sseEventCount(text, 'response.failed'), 0);
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /event: response.output_item.done/);
  });

  await t.test('Chat Completions API -> Anthropic messages, stream converts back to chat chunks', async () => {
    const text = await postSse(baseUrl, '/v1/chat/completions', {
      model: 'qwen3.7-max',
      messages: [{ role: 'developer', content: 'system instruction' }, { role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      stream: true,
    });

    assert.match(text, /data: \[DONE\]/);
    const chunks = jsonPayloads(text);
    assert.equal(chunks[0].object, 'chat.completion.chunk');
    assert.equal(chunks.some(chunk => chunk.choices[0].delta.content === 'Anthropic'), true);
    assert.equal(chunks.some(chunk => chunk.choices[0].delta.tool_calls), true);
    assert.equal(chunks.some(chunk => chunk.choices[0].finish_reason === 'tool_calls'), true);

    const request = upstream.requests.at(-1);
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.body.system, 'system instruction');
    assert.equal(request.body.messages[0].role, 'user');
    assert.equal(request.body.tools[0].name, 'lookup');
    assert.equal(request.body.tools[0].input_schema.type, 'object');
    assert.deepEqual(request.body.tool_choice, { type: 'tool', name: 'lookup' });
  });

  await t.test('Chat Completions API -> OpenAI chat completion, non-stream pass-through with normalization', async () => {
    const response = await postJson(baseUrl, '/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'developer', content: 'system instruction' }, { role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      stream: false,
    });

    assert.equal(response.object, 'chat.completion');
    assert.equal(response.choices[0].message.content, 'OpenAI-compatible answer');

    const request = upstream.requests.at(-1);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.body.model, 'kimi-k2.6');
    assert.equal(request.body.messages[0].role, 'system');
    assert.equal(request.body.tools[0].function.name, 'lookup');
  });

  await t.test('Chat Completions API -> OpenAI chat completion, stream pass-through', async () => {
    const text = await postSse(baseUrl, '/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    assert.match(text, /data: \[DONE\]/);
    const chunks = jsonPayloads(text);
    assert.equal(chunks[0].object, undefined);
    assert.equal(chunks.some(chunk => chunk.choices[0].delta.content === 'Hello'), true);
  });
});
