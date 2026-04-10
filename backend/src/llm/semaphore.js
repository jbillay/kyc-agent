'use strict';

/**
 * Semaphore — in-process concurrency limiter.
 *
 * Limits the number of concurrent async operations to a configured maximum.
 * Operations beyond the limit queue as Promises and are resolved in FIFO order
 * as slots become available.
 *
 * Usage:
 *   const sem = new Semaphore(4); // max 4 concurrent
 *   await sem.acquire();
 *   try {
 *     await doWork();
 *   } finally {
 *     sem.release();
 *   }
 */
class Semaphore {
  /**
   * @param {number} limit - Maximum number of concurrent operations
   */
  constructor(limit) {
    this._limit = limit;
    this._active = 0;
    this._queue = [];
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available,
   * otherwise queues until one is released.
   * @returns {Promise<void>}
   */
  acquire() {
    if (this._active < this._limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  /**
   * Release a slot. If callers are queued, the next one is immediately resolved.
   */
  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
      // active count stays the same: one consumer left, one arrived
    } else {
      this._active--;
    }
  }

  /** @returns {number} Number of currently active operations */
  get active() {
    return this._active;
  }

  /** @returns {number} Number of operations waiting for a slot */
  get queued() {
    return this._queue.length;
  }
}

module.exports = { Semaphore };
