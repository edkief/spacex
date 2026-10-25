export interface FrameStats {
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  drawCalls: number;
  triangles: number;
  entities: number;
}

class FrameMonitorImpl {
  private bufferSize = 300;
  private frames = new Float32Array(this.bufferSize);
  private cursor = 0;
  private count = 0;
  private startTime = 0;

  private budgets = new Map<string, { max: number; lastWarn: number }>();
  private triangleCounters = new Map<string, number>();

  frameStarted() {
    this.startTime = performance.now();
  }

  frameEnded() {
    const duration = performance.now() - this.startTime;
    this.frames[this.cursor] = duration;
    this.cursor = (this.cursor + 1) % this.bufferSize;
    if (this.count < this.bufferSize) this.count++;
  }

  getFrameStats(rendererInfo: any, entityCount: number): FrameStats {
    if (this.count === 0) {
      return { fps: 0, p50: 0, p95: 0, p99: 0, drawCalls: 0, triangles: 0, entities: 0 };
    }

    const sorted = new Float32Array(this.frames.slice(0, this.count)).sort();
    const p50 = sorted[Math.floor(this.count * 0.5)];
    const p95 = sorted[Math.floor(this.count * 0.95)];
    const p99 = sorted[Math.floor(this.count * 0.99)];

    let sum = 0;
    const samples = Math.min(this.count, 60);
    for (let i = 0; i < samples; i++) {
      const idx = (this.cursor - 1 - i + this.bufferSize) % this.bufferSize;
      sum += this.frames[idx];
    }
    const fps = samples > 0 ? 1000 / (sum / samples) : 0;

    return {
      fps,
      p50,
      p95,
      p99,
      drawCalls: rendererInfo.render.calls,
      triangles: rendererInfo.render.triangles,
      entities: entityCount,
    };
  }

  budgetCheck(name: string, measuredMs: number, limitMs: number) {
    const now = Date.now();
    const budget = this.budgets.get(name) || { max: 0, lastWarn: 0 };
    
    if (measuredMs > budget.max) {
      budget.max = measuredMs;
    }
    
    if (measuredMs > limitMs && now - budget.lastWarn > 10000) {
      console.warn(`[Perf Budget] ${name} exceeded budget: ${measuredMs.toFixed(2)}ms > ${limitMs}ms (Max: ${budget.max.toFixed(2)}ms)`);
      budget.lastWarn = now;
    }
    
    this.budgets.set(name, budget);
  }

  setTriangleCount(category: string, count: number) {
    this.triangleCounters.set(category, count);
  }

  getTriangleCount(category: string): number {
    return this.triangleCounters.get(category) || 0;
  }

  reset() {
    this.cursor = 0;
    this.count = 0;
    this.budgets.clear();
  }
}

export const frameMonitor = new FrameMonitorImpl();
