import type { ApiClient } from "../api/client";
import type { KeyStore } from "../crypto/keystore";
import type { Contact } from "../model/user-data";

/** What the sharing flows need from the account and the engine. */
export interface SharingContext {
  api: ApiClient;
  keys: KeyStore;
  userId: string;
  /** Contacts that count; empty while user_data is unreadable. */
  contacts(): readonly Contact[];
}
