/** A session-local Fenwick index for virtual PDF page positions. Pages are 1-based. */
export class PageLayoutIndex {
  #count = 0;
  #gap = 20;
  #heights = new Float64Array(0);
  #tree = new Float64Array(0);

  reset(pageCount: number, estimatedHeight: number, gap = 20): void {
    this.#count = Math.max(0, pageCount);
    this.#gap = gap;
    const size = Math.max(0, estimatedHeight) + gap;
    this.#heights = new Float64Array(this.#count + 1);
    this.#tree = new Float64Array(this.#count + 1);
    for (let page = 1; page <= this.#count; page++) {
      this.#heights[page] = size;
      this.#tree[page] = this.#tree[page]! + size;
      const parent = page + (page & -page);
      if (parent <= this.#count)
        this.#tree[parent] = this.#tree[parent]! + this.#tree[page]!;
    }
  }

  update(page: number, height: number): number {
    if (page < 1 || page > this.#count) return 0;
    const next = Math.max(0, height) + this.#gap;
    const delta = next - this.#heights[page]!;
    if (!delta) return 0;
    this.#heights[page] = next;
    for (let index = page; index <= this.#count; index += index & -index)
      this.#tree[index] = this.#tree[index]! + delta;
    return delta;
  }

  offsetBefore(page: number): number {
    return this.#sum(Math.max(0, Math.min(this.#count, page - 1)));
  }
  totalHeight(): number {
    return this.#sum(this.#count);
  }

  pageAt(offset: number): number {
    if (!this.#count) return 1;
    const target = Math.max(0, Math.min(this.totalHeight() - 1, offset));
    let index = 0,
      sum = 0,
      step = 1;
    while (step << 1 <= this.#count) step <<= 1;
    for (; step; step >>= 1) {
      const next = index + step;
      if (next <= this.#count && sum + this.#tree[next]! <= target) {
        index = next;
        sum += this.#tree[next]!;
      }
    }
    return Math.min(this.#count, index + 1);
  }

  #sum(index: number): number {
    let total = 0;
    for (; index > 0; index -= index & -index) total += this.#tree[index]!;
    return total;
  }
}
