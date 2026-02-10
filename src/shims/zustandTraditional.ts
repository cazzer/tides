import * as React from 'react'
import { createStore } from 'zustand/vanilla'
import { useSyncExternalStoreWithSelector } from './useSyncExternalStoreWithSelector'

const identity = (value: any) => value

export function useStoreWithEqualityFn(
  api: {
    subscribe: (listener: () => void) => () => void
    getState: () => any
    getInitialState: () => any
  },
  selector: (state: any) => any = identity,
  equalityFn?: (a: any, b: any) => boolean
) {
  const slice = useSyncExternalStoreWithSelector(
    api.subscribe,
    api.getState,
    api.getInitialState,
    selector,
    equalityFn
  )
  React.useDebugValue(slice)
  return slice
}

const createWithEqualityFnImpl = (
  createState: (
    set: (partial: any) => void,
    get: () => any,
    api: any
  ) => any,
  defaultEqualityFn?: (a: any, b: any) => boolean
) => {
  const api = createStore(createState)
  const useBoundStoreWithEqualityFn = (
    selector?: (state: any) => any,
    equalityFn = defaultEqualityFn as ((a: any, b: any) => boolean) | undefined
  ) => useStoreWithEqualityFn(api, selector ?? identity, equalityFn)

  Object.assign(useBoundStoreWithEqualityFn, api)
  return useBoundStoreWithEqualityFn
}

export const createWithEqualityFn = (
  createState?: (
    set: (partial: any) => void,
    get: () => any,
    api: any
  ) => any,
  defaultEqualityFn?: (a: any, b: any) => boolean
) => (createState ? createWithEqualityFnImpl(createState, defaultEqualityFn) : createWithEqualityFnImpl)
