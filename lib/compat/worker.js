import net from 'node:net';
import { TextDecoder } from 'node:util';
import { PluginSession } from './plugin-session.js';
import { errorDetails } from './errors.js';

// These are protocol resource bounds, not execution deadlines. Rust owns timeouts.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_BUFFERED_OUTPUT_BYTES = 16 * 1024 * 1024;
const methods = new Set([
  'prepare', 'initialize', 'runner.init', 'runner.capabilities', 'runner.dryRun',
  'runner.mutantRun', 'checker.init', 'checker.group', 'checker.check', 'dispose',
]);

function bridgeAddress(value) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/.exec(value ?? '');
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('STRYKER_RUST_BRIDGE_ADDRESS must be a loopback host:port address.');
  }
  return { host: match[1] === '[::1]' ? '::1' : '127.0.0.1', port };
}

async function main() {
  const address = process.env.STRYKER_RUST_BRIDGE_ADDRESS;
  let token = process.env.STRYKER_RUST_BRIDGE_TOKEN;
  // Configuration and user code must not inherit the control connection secret.
  delete process.env.STRYKER_RUST_BRIDGE_ADDRESS;
  delete process.env.STRYKER_RUST_BRIDGE_TOKEN;
  if (!token) throw new Error('STRYKER_RUST_BRIDGE_TOKEN is required.');
  const socket = net.createConnection(bridgeAddress(address));
  socket.setNoDelay(true);
  let closing = false;
  let queue = Promise.resolve();
  let inputParts = [];
  let inputBytes = 0;
  const pending = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const send = (frame) => {
    if (closing || socket.destroyed) return;
    let serialized = JSON.stringify(frame, (_key, value) => {
      if (['function', 'symbol'].includes(typeof value)) {
        throw new TypeError(`Control frames cannot contain ${typeof value} values.`);
      }
      return value;
    });
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
      if (frame.event === 'log') {
        serialized = JSON.stringify({ version: 1, event: 'log', params: { level: frame.params.level, category: 'CompatibilityWorker', message: 'Plugin log exceeded the frame limit.', args: [] } });
      } else {
        serialized = JSON.stringify({ version: 1, id: frame.id, error: { name: 'FrameTooLargeError', message: 'Plugin result exceeded the frame limit.' } });
      }
    }
    if (socket.writableLength + Buffer.byteLength(serialized) + 1 > MAX_BUFFERED_OUTPUT_BYTES) {
      close();
      return;
    }
    socket.write(`${serialized}\n`);
  };
  const session = new PluginSession((params) => send({ version: 1, event: 'log', params }));

  function close() {
    if (closing) return;
    closing = true;
    // Queue cleanup behind the active operation, never overlapping plugin calls.
    // A hung operation is terminated by the Rust owner.
    queue = queue.then(() => session.dispose()).catch((error) => {
      process.stderr.write(`Compatibility worker cleanup failed: ${errorDetails(error).message}\n`);
      process.exitCode = 1;
    }).finally(() => {
      if (!socket.destroyed) socket.end(() => socket.destroy());
    });
  }

  function protocolError(id, name, message, fatal = false) {
    send({ version: 1, id, error: { name, message } });
    if (fatal) {
      close();
    }
  }

  function receive(line) {
    let frame;
    try {
      frame = JSON.parse(decoder.decode(line));
    } catch {
      protocolError(null, 'ProtocolError', 'Expected one UTF-8 JSON request per line.');
      return;
    }
    const hasId = Number.isSafeInteger(frame?.id) && frame.id > 0;
    const id = hasId ? frame.id : null;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.version !== 1 || !hasId || typeof frame.method !== 'string' || !Object.hasOwn(frame, 'params')) {
      protocolError(id, 'ProtocolError', 'Expected version 1, a positive safe integer id, method, and params.');
      return;
    }
    if (pending.has(id)) {
      protocolError(id, 'DuplicateRequestError', 'Request id is already outstanding.', true);
      return;
    }
    if (!methods.has(frame.method)) {
      protocolError(id, 'UnsupportedMethodError', `Unknown method: ${frame.method}.`);
      return;
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      protocolError(id, 'QueueFullError', 'Too many outstanding requests.', true);
      return;
    }
    pending.add(id);
    queue = queue.then(async () => {
      if (closing) return;
      try {
        const result = await session.invoke(frame.method, frame.params);
        send({ version: 1, id, result: result ?? null });
      } catch (error) {
        send({ version: 1, id, error: errorDetails(error) });
      } finally {
        pending.delete(id);
      }
    });
  }

  socket.once('connect', () => {
    send({ version: 1, event: 'hello', params: { token, pid: process.pid } });
    token = undefined;
  });
  socket.on('data', (chunk) => {
    if (closing) return;
    let offset = 0;
    while (!closing && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (inputBytes + part.length > MAX_FRAME_BYTES) {
        protocolError(null, 'FrameTooLargeError', 'Request exceeded the frame limit.', true);
        return;
      }
      if (newline === -1) {
        inputParts.push(part);
        inputBytes += part.length;
        return;
      }
      const line = inputParts.length ? Buffer.concat([...inputParts, part], inputBytes + part.length) : part;
      inputParts = [];
      inputBytes = 0;
      receive(line);
      offset = newline + 1;
    }
  });
  socket.on('end', close);
  socket.on('close', close);
  socket.on('error', (error) => {
    process.stderr.write(`Compatibility worker connection failed: ${error.message}\n`);
    process.exitCode = 1;
    close();
  });
}

main().catch((error) => {
  process.stderr.write(`Compatibility worker failed: ${errorDetails(error).message}\n`);
  process.exitCode = 1;
});
