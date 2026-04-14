function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function humanDelay(baseMs, varianceMs = 0) {
  const sampled = baseMs + gaussianRandom() * (varianceMs / 3 || 1);
  return Math.max(0, Math.round(sampled));
}

export class InteractionController {
  constructor(chromeClient, options = {}) {
    this.chromeClient = chromeClient;
    this.safePacing = options.safePacing !== false;
    this.batchRestEnabled = options.batchRestEnabled !== false;
    this.runControl = options.runControl || null;
    this.nextRestAt = this.batchRestEnabled ? this.randomRestThreshold() : Number.POSITIVE_INFINITY;
  }

  randomRestThreshold() {
    return 15 + Math.floor(Math.random() * 11);
  }

  async sleepRange(baseMs, varianceMs) {
    const delay = this.safePacing ? humanDelay(baseMs, varianceMs) : baseMs;
    await this.wait(delay);
    return delay;
  }

  async wait(ms) {
    if (this.runControl) {
      await this.runControl.delay(ms);
      return;
    }
    await sleep(ms);
  }

  async maybeRest(processedCount, logger = console) {
    if (!this.batchRestEnabled || processedCount < this.nextRestAt) {
      return 0;
    }

    const restMs = 4000 + Math.floor(Math.random() * 4000);
    logger.log(`短暂休息 ${restMs}ms，保持处理节奏稳定...`);
    await this.wait(restMs);
    this.nextRestAt = processedCount + this.randomRestThreshold();
    return restMs;
  }

  async moveMouseNear(targetX, targetY) {
    const steps = this.safePacing ? 4 + Math.floor(Math.random() * 3) : 2;
    const startX = Math.round(targetX - 40 + Math.random() * 30);
    const startY = Math.round(targetY - 20 + Math.random() * 20);

    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const x = Math.round(startX + (targetX - startX) * progress + (Math.random() - 0.5) * 4);
      const y = Math.round(startY + (targetY - startY) * progress + (Math.random() - 0.5) * 4);
      await this.chromeClient.Input.dispatchMouseEvent({
        type: 'mouseMoved',
        x,
        y,
      });
      await this.wait(10 + Math.floor(Math.random() * 25));
    }
  }

  async clickRect(rect) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const offsetX = (Math.random() - 0.5) * Math.min(18, rect.width * 0.25);
    const offsetY = (Math.random() - 0.5) * Math.min(12, rect.height * 0.25);
    const targetX = Math.round(centerX + offsetX);
    const targetY = Math.round(centerY + offsetY);

    await this.moveMouseNear(targetX, targetY);
    await this.sleepRange(180, 80);

    await this.chromeClient.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });
    await this.wait(25 + Math.floor(Math.random() * 45));
    await this.chromeClient.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });
  }
}
