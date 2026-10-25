/**
 * The long-lived objects of a tab: API client, account and tab sync. They
 * live outside Pinia, so keys and tokens never enter reactive state.
 */
import { Account, ApiClient, type SocketLike } from "@keeman/core";
import type { WorkerLike } from "@keeman/core/argon2-worker";
import { CLIENT_ID } from "./build-info";
import type { RuntimeConfig } from "./config";
import { deviceName } from "./device";
import { kdfMemory, syncMarks } from "./storage";
import { TabSync } from "./tabs";

export interface Services {
  config: RuntimeConfig;
  api: ApiClient;
  account: Account;
  tabs: TabSync;
}

let services: Services | undefined;

function wrapWorker(worker: Worker): WorkerLike {
  return {
    postMessage: (message, transfer) => {
      worker.postMessage(message, transfer);
    },
    addEventListener: (type, listener) => {
      worker.addEventListener(type, (event) => {
        listener({
          data: event instanceof MessageEvent ? event.data : undefined,
        });
      });
    },
    terminate: () => {
      worker.terminate();
    },
  };
}

export function spawnArgon2Worker(): WorkerLike {
  return wrapWorker(
    new Worker(new URL("./workers/argon2.worker.ts", import.meta.url), {
      type: "module",
    }),
  );
}

/** kdbxweb and hash-wasm load only in this worker's chunk. */
export function spawnKdbxWorker(): WorkerLike {
  return wrapWorker(
    new Worker(new URL("./workers/kdbx.worker.ts", import.meta.url), {
      type: "module",
    }),
  );
}

export function createServices(config: RuntimeConfig): Services {
  const tabs = new TabSync();
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    clientId: CLIENT_ID,
    coordinator: tabs,
  });
  const account = new Account({
    api,
    spawnWorker: spawnArgon2Worker,
    device: { name: deviceName(navigator.userAgent), client_type: "web" },
    kdfMemory,
    syncMarks,
  });
  services = { config, api, account, tabs };
  return services;
}

/** The browser WebSocket as the core needs it. */
export function browserSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  return {
    send: (data) => {
      socket.send(data);
    },
    close: (code) => {
      socket.close(code);
    },
    onOpen: (listener) => {
      socket.addEventListener("open", () => {
        listener();
      });
    },
    onMessage: (listener) => {
      socket.addEventListener("message", (event: MessageEvent) => {
        listener(event.data);
      });
    },
    onClose: (listener) => {
      socket.addEventListener("close", (event: CloseEvent) => {
        listener(event.code);
      });
    },
  };
}

export function useServices(): Services {
  if (!services) throw new Error("Services are not created yet");
  return services;
}
