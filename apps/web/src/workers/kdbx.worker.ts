/** KDBX reading and writing off the main thread; one operation per worker. */
import { handleKdbxMessage } from "@keeman/core/kdbx-worker";

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.addEventListener("message", (event) => {
  void handleKdbxMessage(event.data, (message, transfer) => {
    scope.postMessage(message, transfer);
  });
});
