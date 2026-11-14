import { EventEmitter } from 'node:events';
/** In-process event bus: docker events, notifications, monitoring snapshots. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
