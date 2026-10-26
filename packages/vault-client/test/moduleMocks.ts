type Exports<T> = { [K in keyof T]?: unknown }
type Fn = (...args: any[]) => any

/** Whether a function must be returned as is: a class (for its statics) or one with properties */
function isFunctionObject(value: Fn): boolean {
  if (vi.isMockFunction(value)) return false
  return Function.prototype.toString.call(value).startsWith('class') || Object.keys(value).length > 0
}

/**
 * Replaces a module's exports for the current test by spying on its namespace
 * (`import * as session from './session'`). Functions get `implementations[name]` as their
 * implementation, and other values (including classes and functions with properties, so those
 * survive) are returned from a getter.
 *
 * Test files share module state, so mock modules this way (in `beforeEach`) instead of with
 * `vi.mock`. Spies are restored after every test.
 */
export function spyOnExports<T extends object>(module: T, implementations: Exports<T>): void {
  const target = module as Record<string, unknown>
  for (const [name, implementation] of Object.entries(implementations)) {
    const isPlainFunction = typeof implementation === 'function' && !isFunctionObject(implementation as Fn)
    if (typeof target[name] === 'function' && isPlainFunction) {
      vi.spyOn(target as Record<string, Fn>, name).mockImplementation(implementation as Fn)
    } else {
      vi.spyOn(target, name, 'get').mockReturnValue(implementation)
    }
  }
}

const copies = new Map<string, Record<string, unknown>>()

/**
 * A mutable copy of a package's exports. A package's real module namespace is frozen, so the
 * setup file mocks the packages that specs replace with these copies, which specs can then
 * `vi.spyOn`. Each copy is made once per worker, so every module that imports the package sees
 * the same object and its spies.
 */
export async function mutableCopy(id: string): Promise<Record<string, unknown>> {
  let copy = copies.get(id)
  if (!copy) {
    const actual = await vi.importActual<Record<string, unknown>>(id)
    // A CommonJS package's named exports may exist only on its default export
    const defaults = typeof actual.default === 'object' && actual.default !== null ? actual.default : {}
    copy = { ...defaults, ...actual }
    copies.set(id, copy)
  }
  return copy
}
