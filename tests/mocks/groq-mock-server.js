// Mock Groq API server for Wispr Tell E2E and unit testing.
// Runs locally on an ephemeral or configured port, simulating Whisper STT and LLM chat completions.
const http = require('http');

class GroqMockServer {
  constructor(options = {}) {
    this.port = options.port || 0; // 0 = automatic free port
    this.server = null;
    this.history = [];
    this.config = {
      defaultTranscript: 'Hello world, this is a test transcription.',
      defaultPolish: 'Hello world, this is polished text.',
      sttStatus: 200,
      chatStatus: 200,
      retryAfterHeader: null,
      delayMs: 0,
      failureCountBeforeSuccess: 0,
      currentFailures: 0,
      dropConnection: false,
      modelsResponse: { data: [{ id: 'whisper-large-v3-turbo' }, { id: 'llama-3.3-70b-versatile' }] }
    };
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        const address = this.server.address();
        this.port = address.port;
        this.baseUrl = `http://127.0.0.1:${this.port}`;
        resolve(this.baseUrl);
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  reset() {
    this.history = [];
    this.config = {
      defaultTranscript: 'Hello world, this is a test transcription.',
      defaultPolish: 'Hello world, this is polished text.',
      sttStatus: 200,
      chatStatus: 200,
      retryAfterHeader: null,
      delayMs: 0,
      failureCountBeforeSuccess: 0,
      currentFailures: 0,
      dropConnection: false,
      modelsResponse: { data: [{ id: 'whisper-large-v3-turbo' }, { id: 'llama-3.3-70b-versatile' }] }
    };
  }

  configure(overrides = {}) {
    Object.assign(this.config, overrides);
  }

  getHistory() {
    return [...this.history];
  }

  async handleRequest(req, res) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyString = bodyBuffer.toString('utf8');

      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyRaw: bodyBuffer,
        bodyString,
        timestamp: Date.now()
      };
      this.history.push(record);

      if (this.config.dropConnection) {
        req.destroy();
        if (res.socket) res.socket.destroy();
        return;
      }

      if (this.config.delayMs > 0) {
        await new Promise(r => setTimeout(r, this.config.delayMs));
      }

      const url = req.url.split('?')[0];

      // Handle mock control endpoints
      if (url === '/__mock__/configure') {
        try {
          const cfg = JSON.parse(bodyString);
          this.configure(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', config: this.config }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (url === '/__mock__/reset') {
        this.reset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reset' }));
        return;
      }

      if (url === '/__mock__/history') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.history));
        return;
      }

      // Check simulated failure counters (e.g. 429 or 503 for first N attempts)
      if (this.config.failureCountBeforeSuccess > 0) {
        if (this.config.currentFailures < this.config.failureCountBeforeSuccess) {
          this.config.currentFailures++;
          const status = this.config.sttStatus !== 200 ? this.config.sttStatus : 429;
          const headers = { 'Content-Type': 'application/json' };
          if (this.config.retryAfterHeader) {
            headers['retry-after'] = String(this.config.retryAfterHeader);
          }
          res.writeHead(status, headers);
          res.end(JSON.stringify({
            error: {
              message: `Rate limit or server error (attempt ${this.config.currentFailures})`,
              type: status === 429 ? 'rate_limit_exceeded' : 'server_error',
              code: status
            }
          }));
          return;
        }
        // After failureCountBeforeSuccess is reached, succeed (fall through with 200)
      } else {
        if (this.config.sttStatus !== 200 && url.includes('/audio/transcriptions')) {
          const headers = { 'Content-Type': 'application/json' };
          if (this.config.retryAfterHeader) headers['retry-after'] = String(this.config.retryAfterHeader);
          res.writeHead(this.config.sttStatus, headers);
          res.end(JSON.stringify({ error: { message: `STT error status ${this.config.sttStatus}` } }));
          return;
        }
      }

      // 1. Audio Transcriptions Endpoint
      if (url.includes('/audio/transcriptions')) {

        // Check if prompt was injected into multipart
        let promptFound = null;
        const promptMatch = bodyString.match(/name="prompt"\r?\n\r?\n([^\r\n]+)/);
        if (promptMatch) {
          promptFound = promptMatch[1];
        }

        // Check response_format
        const isVerbose = bodyString.includes('name="response_format"\r\n\r\nverbose_json');
        const isText = bodyString.includes('name="response_format"\r\n\r\ntext');

        let responsePayload;
        let contentType = 'application/json';

        if (isText) {
          responsePayload = this.config.defaultTranscript;
          contentType = 'text/plain';
        } else if (isVerbose) {
          responsePayload = JSON.stringify({
            text: this.config.defaultTranscript,
            language: 'english',
            duration: 2.5,
            segments: [
              { id: 0, seek: 0, start: 0.0, end: 2.5, text: this.config.defaultTranscript, tokens: [1, 2, 3] }
            ]
          });
        } else {
          responsePayload = JSON.stringify({
            text: this.config.defaultTranscript,
            prompt_received: promptFound
          });
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(responsePayload);
        return;
      }

      // 2. Chat Completions Endpoint (LLM Polish)
      if (url.includes('/chat/completions')) {
        if (this.config.chatStatus !== 200) {
          const headers = { 'Content-Type': 'application/json' };
          if (this.config.retryAfterHeader) headers['retry-after'] = String(this.config.retryAfterHeader);
          res.writeHead(this.config.chatStatus, headers);
          res.end(JSON.stringify({ error: { message: `Chat error status ${this.config.chatStatus}` } }));
          return;
        }

        let parsedBody = {};
        try { parsedBody = JSON.parse(bodyString); } catch {}

        // Check if client requested streaming
        if (parsedBody.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const words = this.config.defaultPolish.split(' ');
          for (const word of words) {
            const chunk = {
              id: 'chatcmpl-mock',
              choices: [{ delta: { content: word + ' ' } }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Standard non-streaming response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          model: parsedBody.model || 'llama-3.3-70b-versatile',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: this.config.defaultPolish
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 }
        }));
        return;
      }

      // 3. Models verification endpoint (used during onboarding)
      if (url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.config.modelsResponse));
        return;
      }

      // 404 for unknown endpoints
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found on mock server' } }));
    });
  }
}

module.exports = GroqMockServer;
