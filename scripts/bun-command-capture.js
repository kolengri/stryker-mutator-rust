/** Observe one owned exec command without adding listeners or changing its result. */
export function observeUpstreamBunCommand(child, identity, onComplete) {
  const capture = {
    ...identity,
    version: 2,
    chunks: [],
    exitChunkCount: null,
    exit: null,
    // Upstream removes Node's internal stream-close listeners, so a child close
    // event is not guaranteed. Sample process status at the actual stdio closes.
    stdioClose: null,
    childClose: null,
    streams: Object.fromEntries(['stdout', 'stderr'].map((name) => [name, { ended: false, closed: false, error: null }])),
    errors: [],
    complete: false,
  };
  const restore = [];
  let finished = false;
  function observe(emitter, record) {
    const descriptor = Object.getOwnPropertyDescriptor(emitter, 'emit');
    const original = emitter.emit;
    emitter.emit = function (event, ...args) {
      if (this === emitter) record(event, args);
      const result = Reflect.apply(original, this, [event, ...args]);
      finish();
      return result;
    };
    restore.push(() => {
      if (descriptor) Object.defineProperty(emitter, 'emit', descriptor);
      else delete emitter.emit;
    });
  }
  function finish() {
    if (finished || !capture.exit || !Object.values(capture.streams).every((stream) => stream.closed)) return;
    finished = true;
    capture.stdioClose = { code: child.exitCode, signal: child.signalCode };
    capture.complete = capture.errors.length === 0
      && Object.values(capture.streams).every((stream) => stream.ended && stream.error === null)
      && capture.exit.code === capture.stdioClose.code && capture.exit.signal === capture.stdioClose.signal;
    for (const undo of restore) undo();
    onComplete(capture);
  }
  observe(child, (event, args) => {
    if (event === 'exit') {
      if (capture.exit) capture.errors.push('Duplicate child exit');
      else {
        capture.exit = { code: args[0], signal: args[1] };
        capture.exitChunkCount = capture.chunks.length;
      }
    } else if (event === 'close') {
      capture.childClose = { code: args[0], signal: args[1] };
    } else if (event === 'error') capture.errors.push(String(args[0]));
  });
  for (const name of ['stdout', 'stderr']) {
    observe(child[name], (event, args) => {
      const stream = capture.streams[name];
      if (event === 'data') {
        if (stream.ended || stream.closed) capture.errors.push(`Data after ${name} EOF/close`);
        capture.chunks.push({ stream: name, text: args[0].toString() });
      } else if (event === 'end') stream.ended = true;
      else if (event === 'close') stream.closed = true;
      else if (event === 'error') stream.error = String(args[0]);
    });
  }
  return capture;
}
