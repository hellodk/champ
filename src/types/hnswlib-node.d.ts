declare module "hnswlib-node" {
  export class HNSWLib {
    constructor(opts: { dimension: number; maxElements: number });
    addPoint(vector: Float32Array, label: number): void;
    search(
      query: Float32Array,
      k: number,
    ): Array<{ label: number; distance: number }>;
    setEf(ef: number): void;
  }
}
