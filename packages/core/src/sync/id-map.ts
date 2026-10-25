/**
 * IDs of objects created in a vault from elsewhere: moved from another
 * vault or imported from KDBX. An ID is kept unless it
 * is taken in the target; then it gets a new one, once, remembered.
 */
export class IdMap {
  readonly #taken: (id: string, tombstones: ReadonlySet<string>) => boolean;
  readonly #newId: () => string;
  readonly #ids = new Map<string, string>();
  readonly #created = new Set<string>();

  /**
   * `taken`: the ID lives in the target, is corrupt there, is known as a
   * tombstone, or a conflict reported it as one (`tombstones`).
   */
  constructor(
    taken: (id: string, tombstones: ReadonlySet<string>) => boolean,
    newId: () => string,
  ) {
    this.#taken = taken;
    this.#newId = newId;
  }

  /** The ID to use now; replaces a taken one that was not created here. */
  map(id: string, tombstones: ReadonlySet<string> = new Set()): string {
    let current = this.#ids.get(id) ?? id;
    if (!this.#created.has(current) && this.#taken(current, tombstones)) {
      current = this.#newId();
      this.#ids.set(id, current);
    }
    return current;
  }

  /** The current ID without checking. */
  peek(id: string): string {
    return this.#ids.get(id) ?? id;
  }

  /** The object now exists in the target under its current ID. */
  created(id: string): void {
    this.#created.add(this.peek(id));
  }

  /** How many IDs had to change. */
  get changed(): number {
    return this.#ids.size;
  }
}
