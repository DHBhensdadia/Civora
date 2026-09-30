/**
 * State that has to outlive one copy of a module.
 *
 * Next builds this application as more than one server chunk, and it does not
 * share a module registry between them: in this project's own production output,
 * `server/instrumentation.js` pulls `server/chunks/apps_web_src_17mwiv1._.js`
 * while `server/app/api/command/route.js` pulls
 * `server/chunks/apps_web_src_lib_19-dsn4._.js`. A module imported by both is
 * therefore **instantiated twice**, with two sets of module-level state. That is
 * read from the build output, not assumed from documentation.
 *
 * The consequence is specific and easy to get wrong. Anything built at start-up —
 * the demonstration world, the scored population, the control tower's scan memo —
 * exists in the instrumentation copy first, and the copy a route handler reads
 * knows nothing about it. The warm-up then does the whole job a second time on the
 * first request, which is the exact cost it was added to remove.
 *
 * A slot parks a value on `globalThis`, the one thing both copies can see. The
 * value is usually a promise rather than a finished object: a slot holding an
 * in-flight promise also stops two copies that arrive at once from each starting
 * their own build.
 */
export interface SharedSlot<T> {
  /** The value this process has parked, if any. */
  read(): T | undefined;
  /** Park a value, and hand it back. */
  write(value: T): T;
  /**
   * Read it, or create and park it.
   *
   * For state a module mutates rather than replaces — a memo table, a cached
   * dataset — where every copy should start from the same one.
   */
  ensure(create: () => T): T;
}

/** The `globalThis` property a slot is named after, by convention `__civora…`. */
export type SharedKey = `__civora${string}`;

/**
 * A slot on `globalThis`, shared by every copy of every module in this process.
 *
 * The name is a literal so a slot cannot collide with a browser global by
 * accident, and so a reader looking for `__civora` finds all of them at once.
 */
export function sharedSlot<T>(key: SharedKey): SharedSlot<T> {
  const host = globalThis as typeof globalThis & Record<string, unknown>;

  return {
    read: (): T | undefined => host[key] as T | undefined,
    write: (value: T): T => {
      host[key] = value;
      return value;
    },
    ensure: (create: () => T): T => {
      const existing = host[key] as T | undefined;
      if (existing !== undefined) {
        return existing;
      }
      const created = create();
      host[key] = created;
      return created;
    },
  };
}
