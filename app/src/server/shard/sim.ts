export class SimLoop {
  private timer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastTime = 0;
  private tickDuration = 0;

  constructor(
    private readonly tickRate: number = 20,
    private readonly onTick: (dt: number) => void
  ) {
    this.tickDuration = 1000 / this.tickRate;
  }

  start() {
    this.lastTime = Date.now();
    this.timer = setTimeout(() => this.loop(), this.tickDuration);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private loop() {
    const now = Date.now();
    const delta = now - this.lastTime;
    this.lastTime = now;

    this.accumulator += delta;

    let ticksProcessed = 0;
    const maxCatchUp = 5;

    while (this.accumulator >= this.tickDuration && ticksProcessed < maxCatchUp) {
      this.onTick(this.tickDuration / 1000);
      this.accumulator -= this.tickDuration;
      ticksProcessed++;
    }

    if (ticksProcessed >= maxCatchUp) {
      this.accumulator = 0;
    }

    const nextDelay = Math.max(0, this.tickDuration - this.accumulator);
    this.timer = setTimeout(() => this.loop(), nextDelay);
  }
}
