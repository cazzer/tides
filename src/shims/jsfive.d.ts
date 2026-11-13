// jsfive 0.4.0 ships no types: the part renderers/glmFile.ts reads.
declare module 'jsfive' {
  export class Dataset {
    readonly value: ArrayLike<number>
    readonly shape: number[]
    readonly dtype: string
    readonly attrs: Record<string, unknown>
  }
  export class Group {
    readonly keys: string[]
    get(path: string): Dataset | Group | null
    readonly attrs: Record<string, unknown>
  }
  export class File extends Group {
    constructor(buffer: ArrayBuffer, filename?: string)
  }
}
