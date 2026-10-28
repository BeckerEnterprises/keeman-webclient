/**
 * Comparison points of state codes: contradictions the user confirmed,
 * kept for the account in user_data and for this device in the sync marks,
 * plus those not written yet. They only restrict the roles check; a point
 * goes away when acknowledged, when the chain satisfies it, or when newer
 * user_data of the account no longer has it.
 */
import type { StateCode } from "../crypto/state-code";
import type {
  ComparisonChange,
  ComparisonMatch,
  ComparisonPoint,
  Comparisons,
} from "../model/user-data";
import type { ComparisonMark, SyncMarks, UserMarks } from "./marks";

/** What the keeper needs from the account. */
export interface ComparisonPort {
  userId: string;
  marks: SyncMarks;
  /** The comparisons in user_data; `undefined` while it is unreadable. */
  stored(vaultId: string): Comparisons | undefined;
  /** The `seq` of the user_data they come from. */
  seq(): number | undefined;
  /** Writes a change to user_data; `false` if it cannot be written now. */
  save(change: Record<string, ComparisonChange>): Promise<boolean>;
  /** The device clock (Unix ms). */
  now(): number;
}

function keyOf(point: { version: number; code: string }): string {
  return `${String(point.version)}:${point.code}`;
}

function sameMarks(
  a: readonly ComparisonMark[],
  b: readonly ComparisonMark[],
): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        m[0] === other[0] &&
        m[1] === other[1] &&
        m[2] === other[2]
      );
    })
  );
}

export class ComparisonKeeper {
  readonly #port: ComparisonPort;
  /** Confirmed here and not yet in user_data. */
  readonly #added = new Map<string, ComparisonPoint[]>();
  /** Acknowledged or satisfied: removed from user_data and the marks. */
  readonly #removed = new Map<string, Set<string>>();
  readonly #matches = new Map<string, ComparisonMatch>();
  /** The device copy as last read, for the synchronous view. */
  #marks: UserMarks = { vaults: {} };

  constructor(port: ComparisonPort) {
    this.#port = port;
  }

  /** The points in effect for a vault, lowest version first. */
  points(vaultId: string, marks: UserMarks = this.#marks): StateCode[] {
    const removed = this.#removed.get(vaultId) ?? new Set<string>();
    const result = new Map<string, StateCode>();
    const take = (version: number, code: string) => {
      const key = keyOf({ version, code });
      if (!removed.has(key)) result.set(key, { version, code });
    };
    for (const p of this.#port.stored(vaultId)?.points ?? [])
      take(p.version, p.code);
    for (const [version, code] of marks.vaults[vaultId]?.cp ?? [])
      take(version, code);
    for (const p of this.#added.get(vaultId) ?? []) take(p.version, p.code);
    return [...result.values()].sort((a, b) => a.version - b.version);
  }

  /** The last match for display, the newer of stored and unsaved. */
  lastMatch(vaultId: string): ComparisonMatch | undefined {
    const stored = this.#port.stored(vaultId)?.match;
    const pending = this.#matches.get(vaultId);
    if (!pending) return stored;
    if (!stored) return pending;
    return Date.parse(pending.at) >= Date.parse(stored.at) ? pending : stored;
  }

  /** "Matches as entered": a contradiction becomes a point. */
  add(vaultId: string, point: StateCode): void {
    const key = keyOf(point);
    this.#removed.get(vaultId)?.delete(key);
    const added = this.#added.get(vaultId) ?? [];
    if (!added.some((p) => keyOf(p) === key))
      added.push({
        version: point.version,
        code: point.code,
        at: new Date(this.#port.now()).toISOString(),
      });
    this.#added.set(vaultId, added);
  }

  /** Points that went away ("understood", or satisfied by the chain). */
  remove(vaultId: string, points: readonly StateCode[]): void {
    if (points.length === 0) return;
    const removed = this.#removed.get(vaultId) ?? new Set<string>();
    const keys = new Set(points.map(keyOf));
    for (const key of keys) removed.add(key);
    this.#removed.set(vaultId, removed);
    const added = this.#added.get(vaultId);
    if (added)
      this.#added.set(
        vaultId,
        added.filter((p) => !keys.has(keyOf(p))),
      );
  }

  match(vaultId: string, version: number, partner: string | null): void {
    this.#matches.set(vaultId, {
      version,
      at: new Date(this.#port.now()).toISOString(),
      partner,
    });
  }

  /**
   * Brings the device copy up to date with user_data and writes what is
   * pending to user_data where it can; `false` if something waits.
   */
  async flush(vaultIds: Iterable<string>): Promise<boolean> {
    const userId = this.#port.userId;
    const marks = await this.#port.marks.read(userId);
    const seq = this.#port.seq();
    const ids = new Set([
      ...vaultIds,
      ...Object.keys(marks.vaults).filter(
        (id) => (marks.vaults[id]?.cp?.length ?? 0) > 0,
      ),
      ...this.#added.keys(),
      ...this.#removed.keys(),
      ...this.#matches.keys(),
    ]);
    const change: Record<string, ComparisonChange> = {};
    for (const vaultId of ids) {
      const stored = this.#port.stored(vaultId);
      const storedKeys = new Set((stored?.points ?? []).map(keyOf));
      const removed = this.#removed.get(vaultId) ?? new Set<string>();
      const current = marks.vaults[vaultId]?.cp ?? [];
      const next: ComparisonMark[] = [];
      const has = (key: string) =>
        next.some((m) => keyOf({ version: m[0], code: m[1] }) === key);
      for (const [version, code, seen] of current) {
        const key = keyOf({ version, code });
        if (removed.has(key)) continue;
        const inStored = storedKeys.has(key);
        // Newer user_data without the point: another device removed it.
        if (stored && seq !== undefined && seen > 0 && seq > seen && !inStored)
          continue;
        next.push([
          version,
          code,
          inStored && seq !== undefined ? Math.max(seen, seq) : seen,
        ]);
      }
      for (const p of stored?.points ?? [])
        if (!removed.has(keyOf(p)) && !has(keyOf(p)))
          next.push([p.version, p.code, seq ?? 0]);
      for (const p of this.#added.get(vaultId) ?? [])
        if (!has(keyOf(p))) next.push([p.version, p.code, 0]);
      next.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
      if (!sameMarks(current, next))
        await this.#port.marks.replaceComparisons(userId, vaultId, next);
      if (!stored) continue;
      const known = new Map(
        (this.#added.get(vaultId) ?? []).map((p) => [keyOf(p), p]),
      );
      const add = next
        .filter((m) => !storedKeys.has(keyOf({ version: m[0], code: m[1] })))
        .map(
          ([version, code]): ComparisonPoint =>
            known.get(keyOf({ version, code })) ?? {
              version,
              code,
              at: new Date(this.#port.now()).toISOString(),
            },
        );
      const remove = stored.points.filter((p) => removed.has(keyOf(p)));
      const match = this.#matches.get(vaultId);
      if (add.length > 0 || remove.length > 0 || match)
        change[vaultId] = {
          ...(add.length > 0 ? { add } : {}),
          ...(remove.length > 0 ? { remove } : {}),
          ...(match ? { match } : {}),
        };
      else {
        // Nothing waits for user_data any more.
        this.#added.delete(vaultId);
        this.#removed.delete(vaultId);
      }
    }
    this.#marks = await this.#port.marks.read(userId);
    if (Object.keys(change).length === 0) return true;
    if (!(await this.#port.save(change))) return false;
    for (const vaultId of Object.keys(change)) {
      this.#added.delete(vaultId);
      this.#removed.delete(vaultId);
      this.#matches.delete(vaultId);
    }
    return true;
  }
}
