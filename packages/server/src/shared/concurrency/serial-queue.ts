/**
 * Serializes asynchronous operations in FIFO order.
 *
 * A rejected task still rejects the caller's promise while keeping the internal
 * chain settled so subsequent queued operations continue executing cleanly.
 */
export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(operation);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
