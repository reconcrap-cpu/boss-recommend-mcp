import CDP from 'chrome-remote-interface';

export class ChromeClient {
  constructor(port = 9222) {
    this.port = port;
    this.client = null;
  }

  async connect(targetMatcher) {
    const targets = await CDP.List({ port: this.port });
    const target = targets.find((item) => targetMatcher(item));

    if (!target) {
      throw new Error('Could not find a matching Chrome tab. Make sure Boss chat is open.');
    }

    this.client = await CDP({ port: this.port, target });
    const { Runtime, DOM, Page, Input, Network } = this.client;

    await Promise.all([
      Runtime.enable(),
      DOM.enable(),
      Page.enable(),
      Network && typeof Network.enable === 'function' ? Network.enable() : Promise.resolve(),
    ]);

    this.Runtime = Runtime;
    this.DOM = DOM;
    this.Page = Page;
    this.Input = Input;
    this.Network = Network || null;

    return target;
  }

  async evaluate(expression) {
    const result = await this.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Chrome evaluation failed';
      throw new Error(description);
    }

    return result.result?.value;
  }

  async callFunction(fn, arg = null) {
    const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
    return this.evaluate(expression);
  }

  async pressEnter() {
    const payload = {
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      code: 'Enter',
      key: 'Enter',
      unmodifiedText: '\r',
      text: '\r',
    };

    await this.Input.dispatchKeyEvent({
      type: 'keyDown',
      ...payload,
    });
    await this.Input.dispatchKeyEvent({
      type: 'keyUp',
      ...payload,
    });
  }

  async pressEscape() {
    const payload = {
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
      code: 'Escape',
      key: 'Escape',
    };

    await this.Input.dispatchKeyEvent({
      type: 'keyDown',
      ...payload,
    });
    await this.Input.dispatchKeyEvent({
      type: 'keyUp',
      ...payload,
    });
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
