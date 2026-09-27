// Headless Electron mock environment for testing contract interfaces.
const EventEmitter = require('events');
const path = require('path');
const os = require('os');

class MockClipboard {
  constructor() {
    this.text = '';
    this.sequenceNumber = 1000;
    this.formats = new Map();
  }

  readText() {
    return this.text;
  }

  writeText(text) {
    this.text = String(text);
    this.sequenceNumber++;
    this.formats.set('text/plain', this.text);
  }

  getClipboardSequenceNumber() {
    return this.sequenceNumber;
  }

  clear() {
    this.text = '';
    this.sequenceNumber++;
    this.formats.clear();
  }

  snapshot() {
    return {
      text: this.text,
      seq: this.sequenceNumber,
      formats: new Map(this.formats)
    };
  }

  restore(snap) {
    this.text = snap.text;
    this.sequenceNumber++;
    this.formats = new Map(snap.formats);
  }
}

class MockWebContents extends EventEmitter {
  constructor() {
    super();
  }

  send(channel, ...args) {
    this.emit('ipc-message', channel, ...args);
  }
}

class MockBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new MockWebContents();
    this.isVisibleState = options.show !== false;
    this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width || 800, height: options.height || 600 };
  }

  show() {
    this.isVisibleState = true;
    this.emit('show');
  }

  hide() {
    this.isVisibleState = false;
    this.emit('hide');
  }

  isVisible() {
    return this.isVisibleState;
  }

  setBounds(bounds) {
    Object.assign(this.bounds, bounds);
    this.emit('moved');
  }

  getBounds() {
    return { ...this.bounds };
  }

  close() {
    this.emit('closed');
  }

  destroy() {
    this.emit('closed');
  }
}

class MockIPC extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, handler) {
    this.handlers.set(channel, handler);
  }

  async invoke(channel, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for '${channel}'`);
    }
    return await handler({ sender: new MockWebContents() }, ...args);
  }

  send(channel, ...args) {
    this.emit(channel, { sender: new MockWebContents() }, ...args);
  }
}

const mockApp = {
  getPath(name) {
    if (name === 'userData') return path.join(os.tmpdir(), 'wispr-tell-test-userdata');
    if (name === 'temp') return os.tmpdir();
    return os.tmpdir();
  },
  getVersion() {
    return '0.5.5';
  },
  getName() {
    return 'Wispr Tell';
  }
};

const mockNativeTheme = {
  shouldUseDarkColors: true,
  themeSource: 'system',
  on: (event, listener) => {}
};

module.exports = {
  MockClipboard,
  MockBrowserWindow,
  MockIPC,
  mockApp,
  mockNativeTheme,
};
