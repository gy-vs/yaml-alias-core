import type { Document, DocValue } from '../../doc/Document.ts'
import { Alias, resolveAliasToJS } from '../../nodes/Alias.ts'
import { isNode } from '../../nodes/identity.ts'
import { Scalar } from '../../nodes/Scalar.ts'
import type { ToJSContext } from '../../nodes/toJS.ts'
import type { MapLike } from '../../nodes/YAMLMap.ts'
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
  value = toMergeValue(doc, ctx, value)
  if (Array.isArray(value)) {
    for (const it of value) mergeValue(doc, ctx, map, it, isPlainObject)
  } else {
    mergeValue(doc, ctx, map, value, isPlainObject)
  }
}

/**
 * Resolve a merge value into its plain JS form, routing every alias
 * (including aliases nested inside a merge sequence) through the
 * accounting-aware alias resolution so that merge-key aliases count
 * towards `maxAliasCount`. Forward and otherwise unresolved aliases throw
 * the library's own ReferenceError here instead of failing later with an
 * opaque TypeError.
 */
function toMergeValue(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  value: unknown
): unknown {
  if (value instanceof Alias) return resolveAliasToJS(value, doc, ctx)
  if (isNode(value)) return value.toJS(doc, ctx)
  return value
}

function mergeValue(
  doc: Document<DocValue, boolean>,
  ctx: ToJSContext,
  map: MapLike,
  value: unknown,
  isPlainObject: boolean
) {
  const srcMap = toMergeValue(doc, ctx, value)
  if (srcMap === map) {
    const msg = 'Circular alias reference in merge key'
    throw new ReferenceError(msg)
  }
  if (!isMergeSource(srcMap))
    throw new Error('Merge sources must be maps or map aliases')
  for (const [key, value] of getMapEntries(srcMap)) {
    if (map instanceof Map) {
      if (!map.has(key)) map.set(key, value)
    } else if (map instanceof Set) {
      map.add(key)
    } else if (!Object.prototype.hasOwnProperty.call(map, key as PropertyKey)) {
      const propKey = key as PropertyKey
      if (
        !isPlainObject ||
        propKey === '__proto__' ||
        propKey === 'constructor'
      ) {
        Object.defineProperty(map, propKey, {
          value,
          writable: true,
          enumerable: true,
          configurable: true
        })
      } else {
        map[propKey] = value
      }
    }
  }
  return map
}

function isMergeSource(
  value: unknown
): value is Map<unknown, unknown> | Record<PropertyKey, unknown> {
  return (
    value instanceof Map ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof Set))
  )
}

function getMapEntries(srcMap: object): Array<[unknown, unknown]> {
  if (srcMap instanceof Map) return [...srcMap.entries()]
  const entries: Array<[unknown, unknown]> = []
  for (const key of Reflect.ownKeys(srcMap)) {
    const desc = Object.getOwnPropertyDescriptor(srcMap, key)
    if (desc?.enumerable)
      entries.push([key, (srcMap as Record<PropertyKey, unknown>)[key]])
  }
  return entries
}
