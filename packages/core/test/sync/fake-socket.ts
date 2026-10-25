import type { SocketLike } from "../../src/sync/events";

/** A WebSocket stand-in the test drives by hand. */
export class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: number | undefined;
  #open: (() => void)[] = [];
  #message: ((data: unknown) => void)[] = [];
  #close: ((code: number) => void)[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = code;
  }
  onOpen(listener: () => void) {
    this.#open.push(listener);
  }
  onMessage(listener: (data: unknown) => void) {
    this.#message.push(listener);
  }
  onClose(listener: (code: number) => void) {
    this.#close.push(listener);
  }
  open() {
    for (const l of this.#open) l();
  }
  message(value: unknown) {
    for (const l of this.#message)
      l(typeof value === "string" ? value : JSON.stringify(value));
  }
  serverClose(code: number) {
    for (const l of this.#close) l(code);
  }
}
