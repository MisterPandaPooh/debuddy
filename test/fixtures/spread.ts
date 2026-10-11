class Svc {
  private get(k: string): string[] {
    return [k, k.toUpperCase()];
  }
  private blabla(...xs: string[]): number {
    return xs.length;
  }
  run(k: string) {
    const n = this.blabla(...this.get(k));
    const m = Math.max(n, this.get('x').length);
    return n + m;
  }
}
