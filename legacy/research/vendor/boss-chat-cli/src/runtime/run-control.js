function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StopRequestedError extends Error {
  constructor(message = 'Run stop requested') {
    super(message);
    this.name = 'StopRequestedError';
  }
}

export class RunControl {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.state = 'running';
    this.stopRequested = false;
    this.stopReason = '';
    this.pausePromise = null;
    this.resumePause = null;
  }

  isPaused() {
    return this.state === 'paused';
  }

  isStopping() {
    return this.stopRequested;
  }

  pause() {
    if (this.stopRequested || this.state === 'paused') {
      return false;
    }

    this.state = 'paused';
    this.pausePromise = new Promise((resolve) => {
      this.resumePause = resolve;
    });
    this.logger.log('已暂停。按 p 或 r 继续，按 q 停止。');
    return true;
  }

  resume() {
    if (this.state !== 'paused') {
      return false;
    }

    this.state = 'running';
    if (this.resumePause) {
      this.resumePause();
    }
    this.pausePromise = null;
    this.resumePause = null;
    this.logger.log('已继续。');
    return true;
  }

  togglePause() {
    return this.isPaused() ? this.resume() : this.pause();
  }

  requestStop(reason = 'User requested stop') {
    if (this.stopRequested) {
      return false;
    }

    this.stopRequested = true;
    this.stopReason = reason;
    this.state = 'stopping';

    if (this.resumePause) {
      this.resumePause();
    }
    this.pausePromise = null;
    this.resumePause = null;

    this.logger.log(`已请求停止：${reason}`);
    return true;
  }

  async checkpoint() {
    while (this.state === 'paused' && !this.stopRequested) {
      await this.pausePromise;
    }

    if (this.stopRequested) {
      throw new StopRequestedError(this.stopReason || 'Run stop requested');
    }
  }

  async delay(ms, options = {}) {
    const chunkMs = options.chunkMs || 100;
    let remaining = Math.max(0, ms);

    while (remaining > 0) {
      await this.checkpoint();
      const waitMs = Math.min(chunkMs, remaining);
      await sleep(waitMs);
      remaining -= waitMs;
    }
  }
}
