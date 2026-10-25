/** Argon2id off the main thread; one derivation per worker. */
import { handleArgon2Message } from "@keeman/core/argon2-worker";

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.addEventListener("message", (event) => {
  void handleArgon2Message(event.data).then(({ response, transfer }) => {
    scope.postMessage(response, transfer);
  });
});
