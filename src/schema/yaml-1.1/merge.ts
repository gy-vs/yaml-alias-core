import type { Document, DocValue } from '../../doc/Document.ts'
import {
  Alias,
  ALIAS_EXHAUSTION_MESSAGE
} from '../../nodes/Alias.ts'
import { Scalar } from '../../nodes/Scalar.ts'
import type { ToJSContext } from '../../nodes/toJS.ts'
import { type MapLike, YAMLMap } from '../../nodes/YAMLMap.ts'
import type { ScalarTag } from '../types.ts'

// If the value associated with a merge key is a single mapping node, each of
// its key/value pairs is inserted into the current mapping, unless the key
// already exists in it. If the value associated with the merge key is a
// sequence, then this sequence is expected to contain mapping nodes and each
// of these nodes is merged in turn according to its order in the sequence.
// Keys in mapping nodes earlier in the sequence override keys specified in
// later mapping nodes. -- http://yaml.org/type/merge.html

const MERGE_KEY = '<<'

export const merge: ScalarTag & {
  identify(value: unknown): boolean
  test: (value: string) => boolean
} = {
  identify: value =>
    value === MERGE_KEY ||
    (typeof value === 'symbol' && value.description === MERGE_KEY),
  default: 'key',
  tag: 'tag:yaml.org,2002:merge',
  test: str => str === MERGE_KEY,
  resolve: () =>
    Object.assign(new Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
  stringify: () => MERGE_KEY
}

export const isMergeKey = (
  doc: Document<DocValue, boolean>,
  key: unknown
): boolean =>
  (merge.identify(key) ||
    (key instanceof Scalar &&
      (!key.type || key.type === Scalar.PLAIN) &&
      merge.identify(key.value))) &&
  Boolean(doc.schema.tags.some(tag => tag.tag === merge.tag && tag.default))

export function addMergeToJSMap(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  map: MapLike,
  value: unknown,
  isPlainObject: boolean
): void {
  if (value instanceof Alias) {
    // Resolve through Alias.toJS() so that merge-key aliases are included in
    // maxAliasCount accounting, and so that unresolved aliases surface as
    // the library's ReferenceError instead of an internal TypeError.
    const res = resolveMergeAlias(doc, ctx, value)
    mergeJSValue(doc, ctx, map, res, isPlainObject)
  } else if (value instanceof YAMLMap) {
    mergeNodeMap(doc, ctx, map, value, isPlainObject)
  } else if (Array.isArray(value)) {
    // A sequence of merge sources (YAMLSeq extends Array), possibly
    // containing aliases that each need to be counted.
    for (const it of value)
      addMergeToJSMap(doc, ctx, map, it, isPlainObject)
  } else {
    throw new Error('Merge sources must be maps or map aliases')
  }
}

/**
 * Resolve an alias used as a merge source.
 *
 * Cyclic merge sources such as `&A { <<: *A, B: b }` can never finish
 * expanding, so they are reported through the library's resource exhaustion
 * error (ReferenceError) rather than overflowing the call stack.
 */
function resolveMergeAlias(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  alias: Alias
): unknown {
  const source = alias.resolve(doc, ctx)
  if (!source) {
    // Throws the library's "Unresolved alias" ReferenceError.
    return alias.toJS(doc, ctx)
  }

  const resolving = ctx.resolving
  if (resolving?.has(source))
    throw new ReferenceError(ALIAS_EXHAUSTION_MESSAGE)

  return alias.toJS(doc, ctx)
}

/**
 * Merge an already-resolved plain JS value referenced by a merge alias.
 * It is shared with the anchor's own resolution, so it must not be resolved
 * again.
 */
function mergeJSValue(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  map: MapLike,
  value: unknown,
  isPlainObject: boolean
): void {
  if (value instanceof Map) {
    mergeEntries(map, value, isPlainObject)
  } else if (value instanceof YAMLMap) {
    mergeNodeMap(doc, ctx, map, value, isPlainObject)
  } else if (Array.isArray(value)) {
    for (const it of value)
      mergeJSValue(doc, ctx, map, it, isPlainObject)
  } else if (isPlainObjectValue(value)) {
    mergeEntries(map, Object.entries(value), isPlainObject)
  } else {
    throw new Error('Merge sources must be maps or map aliases')
  }
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function mergeNodeMap(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  map: MapLike,
  value: YAMLMap,
  isPlainObject: boolean
) {
  const srcMap = value.toJS(doc, ctx, Map<any, any>)
  if (!(srcMap instanceof Map))
    throw new Error('Merge sources must be maps or map aliases')
  mergeEntries(map, srcMap, isPlainObject)
  return map
}

function mergeEntries(
  map: MapLike,
  entries: Iterable<[any, unknown]>,
  isPlainObject: boolean
) {
  for (const [key, value] of entries) {
    if (map instanceof Map) {
      if (!map.has(key)) map.set(key, value)
    } else if (map instanceof Set) {
      map.add(key)
    } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
      if (!isPlainObject || key === '__proto__' || key === 'constructor') {
        Object.defineProperty(map, key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true
        })
      } else {
        map[key] = value
      }
    }
  }
}
