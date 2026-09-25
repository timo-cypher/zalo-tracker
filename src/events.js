const { EventEmitter } = require('events');

/**
 * EventBus nhẹ để đẩy message mới đến web UI qua SSE.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function emitMessage(payload) {
  emitter.emit('message', payload);
}

function onMessage(listener) {
  emitter.on('message', listener);
  return () => emitter.off('message', listener);
}

module.exports = { emitMessage, onMessage };
