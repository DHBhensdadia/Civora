import type { ZodType } from 'zod';

import type {
  CollectionRef,
  DataProvider,
  ListOptions,
  ProviderHealth,
} from '../ports/data-provider';

/**
 * Document listing order. Identifiers sort lexicographically so that paging by
 * cursor is deterministic and reproducible in tests.
 */
const byId = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0;

class InMemoryCollection<T> implements CollectionRef<T> {
  readonly name: string;
  readonly #schema: ZodType<T>;
  readonly #documents: Map<string, unknown>;

  constructor(name: string, schema: ZodType<T>, documents: Map<string, unknown>) {
    this.name = name;
    this.#schema = schema;
    this.#documents = documents;
  }

  async get(id: string): Promise<T | null> {
    const stored = this.#documents.get(id);
    return stored === undefined ? null : this.#schema.parse(stored);
  }

  async list(options?: ListOptions): Promise<readonly T[]> {
    const ordered = [...this.#documents.entries()].sort(byId);
    const cursor = options?.cursor;
    const afterCursor = cursor === undefined ? ordered : ordered.filter(([id]) => id > cursor);
    const limit = options?.limit ?? afterCursor.length;
    return afterCursor.slice(0, limit).map(([, stored]) => this.#schema.parse(stored));
  }

  async set(id: string, value: T): Promise<void> {
    this.#documents.set(id, this.#schema.parse(value));
  }

  async remove(id: string): Promise<void> {
    this.#documents.delete(id);
  }
}

/**
 * A `DataProvider` backed by a map in this process.
 *
 * It is the default adapter, which is what makes `pnpm dev` work on a machine
 * with no cloud credentials. Data is lost when the process exits; that is
 * deliberate for development and it is never used where durability matters.
 */
export class InMemoryDataProvider implements DataProvider {
  readonly kind = 'in-memory';
  readonly #collections = new Map<string, Map<string, unknown>>();

  collection<T>(name: string, schema: ZodType<T>): CollectionRef<T> {
    let documents = this.#collections.get(name);
    if (documents === undefined) {
      documents = new Map<string, unknown>();
      this.#collections.set(name, documents);
    }
    return new InMemoryCollection<T>(name, schema, documents);
  }

  async health(): Promise<ProviderHealth> {
    return {
      ok: true,
      kind: this.kind,
      detail: `${String(this.#collections.size)} collection(s) held in process memory`,
    };
  }

  async close(): Promise<void> {
    this.#collections.clear();
  }
}
