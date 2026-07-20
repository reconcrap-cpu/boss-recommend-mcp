import assert from "node:assert/strict";
import {
  ALLOWED_CDP_DOMAINS,
  assertNoForbiddenCdpCalls,
  buildBossChromeLaunchArgs,
  chunkHumanText,
  clickPoint,
  clickNodeCenter,
  configureHumanInteraction,
  connectToChromeTargetOrOpen,
  createHumanRestController,
  createBossLoginRequiredError,
  createGuardedCdpClient,
  DEFAULT_REQUIRED_CHROME_FLAGS,
  detectBossLoginState,
  enableDomains,
  ensureChromeDebugPort,
  generateBezierPath,
  getMissingRequiredChromeFlags,
  getNodeBox,
  FORBIDDEN_CDP_DOMAINS,
  FORBIDDEN_CDP_METHODS,
  humanDelay,
  insertText,
  isChromeDebugUnavailableError,
  isBossLoginUrl,
  normalizeHumanBehaviorOptions,
  normalizeHumanRestLevel,
  resolveHumanClickPointForBox,
  scrollNodeIntoView,
  simulateHumanClick
} from "./core/browser/index.js";
import { CHAT_TARGET_URL } from "./domains/chat/constants.js";
import { RECOMMEND_TARGET_URL } from "./domains/recommend/constants.js";
import { RECRUIT_TARGET_URL } from "./domains/recruit/constants.js";

function testForbiddenCdpConfigurationWithoutExecutingMethods() {
  const runtimeDomain = ["Run", "time"].join("");
  const debuggerDomain = ["Debug", "ger"].join("");
  const injectionMethod = ["addScript", "ToEvaluateOnNewDocument"].join("");
  const forbiddenMethod = ["Page", injectionMethod].join(".");
  const documentReplacementMethod = ["Page", ["setDocument", "Content"].join("")].join(".");
  const frameExpressionMethod = [debuggerDomain, ["evaluate", "OnCallFrame"].join("")].join(".");
  assert.equal(FORBIDDEN_CDP_DOMAINS.has(runtimeDomain), true);
  assert.equal(FORBIDDEN_CDP_DOMAINS.has(debuggerDomain), true);
  assert.equal(ALLOWED_CDP_DOMAINS.has(runtimeDomain), false);
  assert.equal(ALLOWED_CDP_DOMAINS.has(debuggerDomain), false);
  assert.equal(FORBIDDEN_CDP_METHODS.has(forbiddenMethod), true);
  assert.equal(FORBIDDEN_CDP_METHODS.has(documentReplacementMethod), true);
  assert.throws(
    () => assertNoForbiddenCdpCalls([{ method: [runtimeDomain, "evaluate"].join(".") }]),
    /Forbidden CDP methods were used/
  );
  assert.throws(
    () => assertNoForbiddenCdpCalls([{ method: forbiddenMethod }]),
    /Forbidden CDP methods were used/
  );
  assert.throws(
    () => assertNoForbiddenCdpCalls([{ method: frameExpressionMethod }]),
    /Forbidden CDP methods were used/
  );
  assert.throws(
    () => assertNoForbiddenCdpCalls([{ method: documentReplacementMethod }]),
    /Forbidden CDP methods were used/
  );
  assert.deepEqual(assertNoForbiddenCdpCalls([{ method: "Page.enable" }]), {
    verified: true,
    proof: "method_log_inspection",
    method_log_count: 1,
    runtime_domain_method_count: 0,
    forbidden_method_count: 0
  });
}

async function testAllowedDomainsAreLogged() {
  const methodLog = [];
  const guarded = createGuardedCdpClient({
    Page: {
      async enable() {
        return { ok: true };
      }
    },
    DOM: {
      async enable() {
        return { ok: true };
      }
    }
  }, { methodLog });

  await enableDomains(guarded, ["Page", "DOM"]);
  assert.deepEqual(methodLog.map((entry) => entry.method), ["Page.enable", "DOM.enable"]);
  assertNoForbiddenCdpCalls(methodLog);
}

async function testGuardedClientReconnectsClosedTransport() {
  const calls = [];
  const methodLog = [];
  const listener = () => {};
  function makeClient(name, { failGetBody = false } = {}) {
    return {
      Page: {
        async enable() {
          calls.push(`${name}:Page.enable`);
          return {};
        },
        async bringToFront() {
          calls.push(`${name}:Page.bringToFront`);
          return {};
        }
      },
      Network: {
        async enable() {
          calls.push(`${name}:Network.enable`);
          return {};
        },
        async setCacheDisabled(params) {
          calls.push(`${name}:Network.setCacheDisabled:${params.cacheDisabled}`);
          return {};
        },
        responseReceived(nextListener) {
          calls.push(`${name}:Network.responseReceived:${nextListener === listener}`);
        },
        async getResponseBody() {
          calls.push(`${name}:Network.getResponseBody`);
          if (failGetBody) {
            throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
          }
          return { body: name };
        }
      },
      async close() {
        calls.push(`${name}:close`);
      }
    };
  }

  const first = makeClient("first", { failGetBody: true });
  const second = makeClient("second");
  const guarded = createGuardedCdpClient(first, {
    methodLog,
    reconnect: async () => second
  });

  await enableDomains(guarded, ["Page", "Network"]);
  await guarded.Page.bringToFront();
  await guarded.Network.setCacheDisabled({ cacheDisabled: true });
  guarded.Network.responseReceived(listener);

  const result = await guarded.Network.getResponseBody({ requestId: "1" });
  assert.deepEqual(result, { body: "second" });
  assert.deepEqual(calls, [
    "first:Page.enable",
    "first:Network.enable",
    "first:Page.bringToFront",
    "first:Network.setCacheDisabled:true",
    "first:Network.responseReceived:true",
    "first:Network.getResponseBody",
    "second:Page.enable",
    "second:Network.enable",
    "second:Network.setCacheDisabled:true",
    "second:Network.responseReceived:true",
    "second:Network.getResponseBody"
  ]);
  const initialBodyCall = methodLog.find((entry) => entry.method === "Network.getResponseBody");
  const replayedBodyCall = methodLog.find((entry) => entry.method === "Network.getResponseBody:retry_after_reconnect");
  assert.equal(initialBodyCall?.connection_epoch, 1);
  assert.equal(initialBodyCall?.replay_policy, "safe_read_only");
  assert.equal(replayedBodyCall?.connection_epoch, 2);
  assert.equal(replayedBodyCall?.replay_of_connection_epoch, 1);
  assert.equal(guarded.__connectionEpoch, 2);
  assertNoForbiddenCdpCalls(methodLog);
}

async function testGuardedClientDoesNotReplayScreenshot() {
  const calls = [];
  const methodLog = [];
  const first = {
    Page: {
      async captureScreenshot() {
        calls.push("first:Page.captureScreenshot");
        throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
      }
    }
  };
  const second = {
    Page: {
      async captureScreenshot() {
        calls.push("second:Page.captureScreenshot");
        return { data: "unexpected" };
      }
    }
  };
  const guarded = createGuardedCdpClient(first, {
    methodLog,
    reconnect: async () => second
  });

  assert.equal(guarded.__connectionEpoch, 1);
  await assert.rejects(
    () => guarded.Page.captureScreenshot({ format: "jpeg" }),
    (error) => {
      assert.equal(error.cdp_method, "Page.captureScreenshot");
      assert.equal(error.cdp_connection_epoch, 1);
      assert.equal(error.cdp_outcome_unknown, true);
      assert.equal(error.cdp_reconnected, true);
      assert.equal(error.cdp_reconnected_epoch, 2);
      assert.equal(error.cdp_replay_policy, "not_allowlisted");
      assert.equal(error.cdp_replay_suppressed, true);
      return true;
    }
  );
  assert.equal(guarded.__connectionEpoch, 2);
  assert.deepEqual(calls, ["first:Page.captureScreenshot"]);
  assert.deepEqual(methodLog.map((entry) => entry.method), ["Page.captureScreenshot"]);
  assert.equal(methodLog[0].connection_epoch, 1);
}

async function testGuardedClientDoesNotReplayStateChangingOrUnknownMethods() {
  async function exercise(method, invoke) {
    const calls = [];
    let reconnectCount = 0;
    function makeClient(name, { fail = false } = {}) {
      return {
        Page: {
          async navigate() {
            calls.push(`${name}:Page.navigate`);
            if (fail) throw new Error("Connection closed");
            return {};
          },
          async bringToFront() {
            calls.push(`${name}:Page.bringToFront`);
            if (fail) throw new Error("Connection closed");
            return {};
          }
        },
        DOM: {
          async futureReadMethod() {
            calls.push(`${name}:DOM.futureReadMethod`);
            if (fail) throw new Error("Connection closed");
            return {};
          }
        }
      };
    }
    const guarded = createGuardedCdpClient(makeClient("first", { fail: true }), {
      reconnect: async () => {
        reconnectCount += 1;
        return makeClient("second");
      }
    });
    await assert.rejects(
      () => invoke(guarded),
      (error) => {
        assert.equal(error.cdp_method, method);
        assert.equal(error.cdp_outcome_unknown, true);
        assert.equal(error.cdp_replay_suppressed, true);
        return true;
      }
    );
    assert.equal(reconnectCount, 1);
    assert.deepEqual(calls, [`first:${method}`]);
    assert.equal(guarded.__connectionEpoch, 2);
  }

  await exercise("Page.navigate", (guarded) => guarded.Page.navigate({ url: "https://example.test" }));
  await exercise("Page.bringToFront", (guarded) => guarded.Page.bringToFront());
  await exercise("DOM.futureReadMethod", (guarded) => guarded.DOM.futureReadMethod({}));
}

async function testGuardedClientCanExplicitlyAbandonAndReconnect() {
  const calls = [];
  const listener = () => {};
  function makeClient(name) {
    return {
      Page: {
        async enable() {
          calls.push(`${name}:Page.enable`);
          return {};
        },
        frameResized(nextListener) {
          calls.push(`${name}:Page.frameResized:${nextListener === listener}`);
        }
      }
    };
  }
  const guarded = createGuardedCdpClient(makeClient("first"), {
    reconnect: async () => makeClient("second")
  });

  await guarded.Page.enable();
  guarded.Page.frameResized(listener);
  const result = await guarded.__abandonAndReconnect({ reason: "screenshot_timeout" });

  assert.deepEqual(result, {
    reconnected: true,
    previous_connection_epoch: 1,
    connection_epoch: 2,
    reason: "screenshot_timeout"
  });
  assert.equal(guarded.__connectionEpoch, 2);
  assert.deepEqual(calls, [
    "first:Page.enable",
    "first:Page.frameResized:true",
    "second:Page.enable",
    "second:Page.frameResized:true"
  ]);
}

async function testGuardedClientAnnotatesCdpNodeErrors() {
  const guarded = createGuardedCdpClient({
    DOM: {
      async querySelector() {
        throw new Error("Could not find node with given id");
      }
    }
  });

  await assert.rejects(
    () => guarded.DOM.querySelector({ nodeId: 42, selector: ".candidate-card" }),
    (error) => {
      assert.equal(error.cdp_method, "DOM.querySelector");
      assert.match(error.cdp_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(error.cdp_node_id, 42);
      assert.deepEqual(error.cdp_param_keys, ["nodeId", "selector"]);
      return true;
    }
  );
}

async function testNodeHelpersPreserveGuardedCdpDiagnostics() {
  const sourceError = new Error("Connection closed while reading node box");
  sourceError.cdp_backend_node_id = 501;
  sourceError.cdp_search_id = "search-7";
  let secondClientCalls = 0;
  const guarded = createGuardedCdpClient({
    DOM: {
      async getBoxModel() {
        throw sourceError;
      }
    }
  }, {
    reconnect: async () => ({
      DOM: {
        async getBoxModel() {
          secondClientCalls += 1;
          return {};
        }
      }
    })
  });

  await assert.rejects(
    () => getNodeBox(guarded, 42),
    (error) => {
      assert.equal(error.cause, sourceError);
      assert.equal(error.cdp_method, "DOM.getBoxModel");
      assert.equal(error.cdp_node_id, 42);
      assert.equal(error.cdp_backend_node_id, 501);
      assert.equal(error.cdp_search_id, "search-7");
      assert.equal(error.cdp_connection_epoch, 1);
      assert.equal(error.cdp_replay_policy, "not_allowlisted");
      assert.equal(error.cdp_reconnected, true);
      assert.equal(error.cdp_reconnected_epoch, 2);
      assert.equal(error.cdp_replay_suppressed, true);
      assert.equal(error.cdp_outcome_unknown, true);
      assert.deepEqual(error.cdp_param_keys, ["nodeId"]);
      assert.equal(Object.hasOwn(error, "params"), false);
      return true;
    }
  );
  assert.equal(secondClientCalls, 0);

  const scrollSourceError = new Error("Session closed while scrolling node");
  scrollSourceError.cdp_search_id = "search-8";
  const scrollGuarded = createGuardedCdpClient({
    DOM: {
      async scrollIntoViewIfNeeded() {
        throw scrollSourceError;
      }
    }
  }, {
    reconnect: async () => {
      throw new Error("reconnect refused");
    }
  });

  await assert.rejects(
    () => scrollNodeIntoView(scrollGuarded, 73),
    (error) => {
      assert.equal(error.cause, scrollSourceError);
      assert.equal(error.cdp_method, "DOM.scrollIntoViewIfNeeded");
      assert.equal(error.cdp_node_id, 73);
      assert.equal(error.cdp_search_id, "search-8");
      assert.equal(error.cdp_connection_epoch, 1);
      assert.equal(error.cdp_replay_policy, "not_allowlisted");
      assert.equal(error.cdp_replay_suppressed, true);
      assert.equal(error.cdp_outcome_unknown, true);
      assert.equal(error.cdp_reconnect_error, "reconnect refused");
      assert.deepEqual(error.cdp_param_keys, ["nodeId"]);
      assert.equal(Object.hasOwn(error, "params"), false);
      return true;
    }
  );
}

async function testUnexpectedDomainIsRejected() {
  const guarded = createGuardedCdpClient({
    Runtime: {
      async enable() {
        return { ok: true };
      }
    }
  });
  await assert.rejects(
    () => enableDomains(guarded, ["Runtime"]),
    /not allowed/
  );
}

function testBossLoginUrlDetection() {
  assert.equal(isBossLoginUrl("https://www.zhipin.com/web/user/?ka=bticket"), true);
  assert.equal(isBossLoginUrl("https://passport.zhipin.com/login"), true);
  assert.equal(isBossLoginUrl("https://www.zhipin.com/web/chat/recommend"), false);
}

function testBossLoginRequiredErrorShape() {
  const error = createBossLoginRequiredError({
    domain: "recommend",
    currentUrl: "https://www.zhipin.com/web/user/?ka=bticket",
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    loginDetection: { requires_login: true, reason: "url" },
    chrome: { launched: true, port: 9222 }
  });
  assert.equal(error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(error.requires_login, true);
  assert.equal(error.retryable, true);
  assert.equal(error.login_url.includes("zhipin.com/web/user"), true);
  assert.equal(error.login_detection.reason, "url");
  assert.equal(error.chrome.launched, true);
}

function testChromeDebugUnavailableDetection() {
  assert.equal(isChromeDebugUnavailableError(new Error("connect ECONNREFUSED 127.0.0.1:9222")), true);
  assert.equal(isChromeDebugUnavailableError(new Error("No matching Chrome target found")), false);
}

function testBossChromeLaunchArgsContainRequiredFlagsOnce() {
  const args = buildBossChromeLaunchArgs({
    port: 9555,
    userDataDir: "C:\\tmp\\boss-profile-9555",
    url: "https://www.zhipin.com/web/chat/recommend",
    extraArgs: [
      ...DEFAULT_REQUIRED_CHROME_FLAGS,
      "--disable-features=Foo"
    ]
  });
  for (const flag of DEFAULT_REQUIRED_CHROME_FLAGS) {
    if (flag.startsWith("--disable-features=")) {
      const disableFeatureArgs = args.filter((arg) => arg.startsWith("--disable-features="));
      assert.equal(disableFeatureArgs.length, 1, "disable-features should be merged into one switch");
      assert.ok(disableFeatureArgs[0].includes("CalculateNativeWinOcclusion"));
      assert.ok(disableFeatureArgs[0].includes("Foo"));
    } else {
      assert.equal(args.filter((arg) => arg === flag).length, 1, `${flag} should appear once`);
    }
  }
  assert.equal(args.includes("--start-maximized"), true);
  assert.deepEqual(getMissingRequiredChromeFlags(args), []);
}

function testChromeRequiredFlagDetection() {
  assert.deepEqual(
    getMissingRequiredChromeFlags([
      "--remote-debugging-port=9222",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Foo,CalculateNativeWinOcclusion"
    ]),
    []
  );
  assert.deepEqual(
    getMissingRequiredChromeFlags(["--remote-debugging-port=9222"]),
    DEFAULT_REQUIRED_CHROME_FLAGS
  );
  assert.deepEqual(
    getMissingRequiredChromeFlags([
      "--remote-debugging-port=9222",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-features=Foo"
    ]),
    ["--disable-features=CalculateNativeWinOcclusion"]
  );
}

async function testEnsureChromeDebugPortLaunchesWhenMissing() {
  let launched = false;
  const result = await ensureChromeDebugPort({
    port: 9555,
    url: "https://www.zhipin.com/web/chat/recommend",
    userDataDir: "C:\\tmp\\boss-profile-9555",
    _deps: {
      async listChromeTargetsImpl() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9555");
      },
      async launchChromeDebugInstanceImpl(params) {
        launched = true;
        return {
          launched: true,
          port: params.port,
          url: params.url,
          user_data_dir: params.userDataDir,
          launch_args: buildBossChromeLaunchArgs({
            port: params.port,
            userDataDir: params.userDataDir,
            url: params.url
          }),
          readiness: { elapsed_ms: 1, target_count: 1 }
        };
      }
    }
  });
  assert.equal(launched, true);
  assert.equal(result.launched, true);
  assert.equal(result.guard_checked, true);
  assert.equal(result.required_flags_ok, true);
  assert.equal(result.relaunch.reason, "port_unreachable");
  assert.deepEqual(result.missing_flags, []);
}

async function testEnsureChromeDebugPortReusesCompliantChrome() {
  const result = await ensureChromeDebugPort({
    port: 9556,
    _deps: {
      async listChromeTargetsImpl() {
        return [{ id: "1", type: "page", url: "https://www.zhipin.com/web/chat/recommend" }];
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: true,
          source: "process_list",
          arguments: [
            "--remote-debugging-port=9556",
            ...DEFAULT_REQUIRED_CHROME_FLAGS
          ],
          processes: [{ pid: 1234 }]
        };
      },
      async launchChromeDebugInstanceImpl() {
        throw new Error("should not launch");
      }
    }
  });
  assert.equal(result.reused, true);
  assert.equal(result.replaced, false);
  assert.equal(result.required_flags_ok, true);
  assert.deepEqual(result.missing_flags, []);
  assert.equal(result.command_line_source, "process_list");
}

async function testEnsureChromeDebugPortReplacesNoncompliantLocalChrome() {
  let closed = false;
  let launched = false;
  const result = await ensureChromeDebugPort({
    port: 9557,
    url: "https://www.zhipin.com/web/chat/recommend",
    userDataDir: "C:\\tmp\\boss-profile-9557",
    _deps: {
      async listChromeTargetsImpl() {
        return [{ id: "1", type: "page", url: "about:blank" }];
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: true,
          source: "process_list",
          arguments: ["--remote-debugging-port=9557"],
          processes: [{ pid: 2222 }]
        };
      },
      async closeChromeDebugInstanceImpl(params) {
        closed = true;
        assert.deepEqual(params.processes, [{ pid: 2222 }]);
        return {
          ok: true,
          method: "Browser.close",
          elapsed_ms: 10
        };
      },
      async launchChromeDebugInstanceImpl(params) {
        launched = true;
        return {
          launched: true,
          port: params.port,
          url: params.url,
          user_data_dir: params.userDataDir,
          launch_args: buildBossChromeLaunchArgs({
            port: params.port,
            userDataDir: params.userDataDir,
            url: params.url
          }),
          readiness: { elapsed_ms: 1, target_count: 1 }
        };
      }
    }
  });
  assert.equal(closed, true);
  assert.equal(launched, true);
  assert.equal(result.replaced, true);
  assert.equal(result.required_flags_ok, true);
  assert.equal(result.close_method, "Browser.close");
  assert.deepEqual(result.missing_flags, DEFAULT_REQUIRED_CHROME_FLAGS);
  assert.equal(result.relaunch.reason, "missing_required_flags");
}

async function testEnsureChromeDebugPortReplacesUnknownLocalChrome() {
  let closed = false;
  let launched = false;
  const result = await ensureChromeDebugPort({
    port: 9559,
    url: "https://www.zhipin.com/web/chat/recommend",
    _deps: {
      async listChromeTargetsImpl() {
        return [{ id: "1", type: "page", url: "about:blank" }];
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: false,
          source: "process_list",
          arguments: [],
          processes: [],
          error: "No local process could prove the launch flags"
        };
      },
      async closeChromeDebugInstanceImpl(params) {
        closed = true;
        assert.deepEqual(params.processes, []);
        return {
          ok: true,
          method: "Browser.close",
          elapsed_ms: 10
        };
      },
      async launchChromeDebugInstanceImpl(params) {
        launched = true;
        return {
          launched: true,
          port: params.port,
          url: params.url,
          user_data_dir: params.userDataDir,
          launch_args: buildBossChromeLaunchArgs({
            port: params.port,
            userDataDir: params.userDataDir,
            url: params.url
          }),
          readiness: { elapsed_ms: 1, target_count: 1 }
        };
      }
    }
  });
  assert.equal(closed, true);
  assert.equal(launched, true);
  assert.equal(result.replaced, true);
  assert.equal(result.command_line_error, "No local process could prove the launch flags");
  assert.deepEqual(result.missing_flags, DEFAULT_REQUIRED_CHROME_FLAGS);
}

async function testEnsureChromeDebugPortRejectsNonLocalMissingFlags() {
  let closed = false;
  await assert.rejects(
    () => ensureChromeDebugPort({
      host: "192.168.1.10",
      port: 9558,
      _deps: {
        async listChromeTargetsImpl() {
          return [{ id: "1", type: "page", url: "about:blank" }];
        },
        async inspectChromeDebugCommandLineImpl() {
          return {
            ok: false,
            source: "cdp_browser_command_line",
            arguments: [],
            error: "Browser.getBrowserCommandLine unavailable"
          };
        },
        async closeChromeDebugInstanceImpl() {
          closed = true;
          return { ok: true };
        }
      }
    }),
    (error) => {
      assert.equal(error.code, "CHROME_REQUIRED_FLAGS_MISSING_NON_LOCAL");
      assert.equal(error.chrome_guard.missing_flags.length, DEFAULT_REQUIRED_CHROME_FLAGS.length);
      return /missing required Chrome flags/i.test(error.message);
    }
  );
  assert.equal(closed, false);
}

async function testConnectToChromeTargetOrOpenRunsGuardForBossTargets() {
  for (const targetUrl of [RECOMMEND_TARGET_URL, RECRUIT_TARGET_URL, CHAT_TARGET_URL]) {
    const events = [];
    const result = await connectToChromeTargetOrOpen({
      port: 9560,
      targetUrl,
      targetUrlIncludes: targetUrl,
      _deps: {
        async ensureChromeDebugPortImpl(params) {
          events.push(`ensure:${params.url}`);
          return {
            launched: false,
            reused: true,
            port: params.port,
            guard_checked: true,
            required_flags: DEFAULT_REQUIRED_CHROME_FLAGS,
            missing_flags: [],
            required_flags_ok: true,
            replaced: false,
            close_method: null,
            relaunch: null
          };
        },
        async connectToChromeTargetImpl() {
          events.push("connect");
          if (events.filter((event) => event === "connect").length === 1) {
            throw new Error("No matching Chrome target found");
          }
          return {
            client: {},
            rawClient: {},
            target: { id: "opened", type: "page", url: targetUrl },
            methodLog: [],
            async close() {}
          };
        },
        async openChromeTargetImpl(params) {
          events.push(`open:${params.url}`);
          return {
            ok: true,
            method: "PUT",
            target_id: "opened",
            url: params.url
          };
        }
      }
    });
    assert.deepEqual(events, [
      `ensure:${targetUrl}`,
      "connect",
      `open:${targetUrl}`,
      "connect"
    ]);
    assert.equal(result.target.url, targetUrl);
    assert.equal(result.chrome.guard_checked, true);
    assert.equal(result.chrome.required_flags_ok, true);
    assert.deepEqual(result.chrome.missing_flags, []);
    assert.equal(result.chrome.target_created, true);
    assert.equal(result.chrome.open_attempt.url, targetUrl);
  }
}

function createSequenceRandom(values = []) {
  let index = 0;
  return () => {
    const value = values[index] ?? 0.5;
    index += 1;
    return value;
  };
}

function createPatternRandom() {
  let index = 0;
  return () => {
    const value = ((index * 37) % 100) / 100;
    index += 1;
    return value;
  };
}

function testHumanDelayAndBezierPath() {
  const delay = humanDelay(260, 0, { minMs: 100, random: createSequenceRandom([0.5]) });
  assert.equal(delay, 260);
  const path = generateBezierPath({ x: 0, y: 0 }, { x: 30, y: 15 }, {
    steps: 3,
    random: createSequenceRandom([0.5, 0.5]),
    controlJitterX: 0,
    controlJitterY: 0
  });
  assert.equal(path.length, 4);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[path.length - 1], { x: 30, y: 15 });
}

async function testSimulateHumanClickUsesOnlyInputCdp() {
  const events = [];
  const methodLog = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async dispatchMouseEvent(params) {
        events.push(params);
        return {};
      }
    }
  }, { methodLog });
  const result = await simulateHumanClick(guarded, 100, 120, {
    startPoint: { x: 20, y: 30 },
    random: createSequenceRandom(Array.from({ length: 80 }, () => 0.5)),
    sleepFn: async () => {},
    moveSteps: 4,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0,
    delayMs: 0
  });
  assert.equal(result.mode, "human");
  assert.equal(result.path_points, 5);
  assert.equal(events.some((event) => event.type === "mousePressed"), true);
  assert.equal(events.some((event) => event.type === "mouseReleased"), true);
  assert.equal(events.filter((event) => event.type === "mouseMoved").length > 3, true);
  assert.deepEqual([...new Set(methodLog.map((entry) => entry.method))], ["Input.dispatchMouseEvent"]);
  assertNoForbiddenCdpCalls(methodLog);
}

async function testConfiguredHumanInteractionControlsClickPoint() {
  const events = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async dispatchMouseEvent(params) {
        events.push(params);
        return {};
      }
    }
  });
  await clickPoint(guarded, 10, 10, { delayMs: 0 });
  assert.deepEqual(events.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);

  events.length = 0;
  configureHumanInteraction(guarded, {
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 80 }, () => 0.5)),
    sleepFn: async () => {},
    moveSteps: 2,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0
  });
  await clickPoint(guarded, 10, 10, { delayMs: 0 });
  assert.equal(events.filter((event) => event.type === "mouseMoved").length > 1, true);
  assert.equal(events.at(-2).type, "mousePressed");
  assert.equal(events.at(-1).type, "mouseReleased");
}

function testHumanBehaviorNormalization() {
  const defaultBehavior = normalizeHumanBehaviorOptions();
  assert.equal(defaultBehavior.enabled, true);
  assert.equal(defaultBehavior.profile, "paced_with_rests");
  assert.equal(defaultBehavior.restEnabled, true);
  assert.equal(defaultBehavior.restLevel, "low");
  assert.equal(defaultBehavior.clickMovement, true);
  assert.equal(defaultBehavior.textEntry, true);
  assert.equal(defaultBehavior.listScrollJitter, true);

  const explicitBaseline = normalizeHumanBehaviorOptions({ profile: "baseline" });
  assert.equal(explicitBaseline.enabled, false);
  assert.equal(explicitBaseline.restEnabled, false);

  const paced = normalizeHumanBehaviorOptions({ profile: "paced" });
  assert.equal(paced.enabled, true);
  assert.equal(paced.clickMovement, true);
  assert.equal(paced.textEntry, true);
  assert.equal(paced.listScrollJitter, true);
  assert.equal(paced.restEnabled, false);

  const legacy = normalizeHumanBehaviorOptions(null, { legacyEnabled: true });
  assert.equal(legacy.profile, "paced_with_rests");
  assert.equal(legacy.restEnabled, true);
  assert.equal(legacy.shortRest, true);
  assert.equal(legacy.batchRest, true);

  const safePacing = normalizeHumanBehaviorOptions(null, { safePacing: true });
  assert.equal(safePacing.profile, "paced");
  assert.equal(safePacing.actionCooldown, true);
  assert.equal(safePacing.restEnabled, false);

  const mediumRest = normalizeHumanBehaviorOptions({ profile: "paced_with_rests", restLevel: "medium" });
  assert.equal(mediumRest.restEnabled, true);
  assert.equal(mediumRest.restLevel, "medium");

  const highRestAlias = normalizeHumanBehaviorOptions({ profile: "paced_with_rests", rest_level: "high" });
  assert.equal(highRestAlias.restLevel, "high");

  const invalidRest = normalizeHumanBehaviorOptions({ profile: "paced_with_rests", restLevel: "aggressive" });
  assert.equal(invalidRest.restLevel, "low");

  const pacedHigh = normalizeHumanBehaviorOptions({ profile: "paced", restLevel: "high" });
  assert.equal(pacedHigh.restLevel, "high");
  assert.equal(pacedHigh.restEnabled, false);

  assert.equal(normalizeHumanRestLevel("med"), "medium");
}

async function testHumanClickPointAndChunkedText() {
  const point = resolveHumanClickPointForBox({
    center: { x: 50, y: 20 },
    rect: { x: 0, y: 0, width: 100, height: 40 }
  }, {
    random: createSequenceRandom([0, 1]),
    safeClickInsetRatio: 0.2,
    safeClickMinInsetPx: 4,
    safeClickMaxInsetPx: 20
  });
  assert.equal(point.mode, "safe_inset");
  assert.equal(point.x, 20);
  assert.equal(point.y, 32);

  const smallPoint = resolveHumanClickPointForBox({
    center: { x: 10, y: 10 },
    rect: { x: 0, y: 0, width: 20, height: 20 }
  });
  assert.equal(smallPoint.mode, "center");
  assert.equal(smallPoint.x, 10);

  const chunks = chunkHumanText("abcdef", {
    random: createSequenceRandom([0, 0, 0]),
    minLength: 2,
    maxLength: 2
  });
  assert.deepEqual(chunks, ["ab", "cd", "ef"]);

  const inserted = [];
  const sleeps = [];
  const mouseEvents = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async insertText(params) {
        inserted.push(params.text);
      },
      async dispatchMouseEvent(params) {
        mouseEvents.push(params);
      }
    },
    DOM: {
      async scrollIntoViewIfNeeded() {},
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 40, 0, 40]
          }
        };
      }
    }
  });
  configureHumanInteraction(guarded, {
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 20 }, () => 0)),
    sleepFn: async (ms) => sleeps.push(ms),
    moveSteps: 1,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0,
    textChunkMinLength: 2,
    textChunkMaxLength: 2,
    textChunkDelayBaseMs: 0,
    textChunkDelayVarianceMs: 0
  });
  const textResult = await insertText(guarded, "abcdef");
  assert.equal(textResult.mode, "chunked");
  assert.deepEqual(inserted, ["ab", "cd", "ef"]);

  inserted.length = 0;
  mouseEvents.length = 0;
  const humanClickBox = await clickNodeCenter(guarded, 1, { delayMs: 0 });
  const press = mouseEvents.find((event) => event.type === "mousePressed");
  assert.equal(inserted.length, 0);
  assert.deepEqual(sleeps, []);
  assert.ok(press);
  assert.notEqual(Math.round(press.x), 50);
  assert.equal(humanClickBox.click_target.mode, "safe_inset");

  mouseEvents.length = 0;
  const deterministicClickBox = await clickNodeCenter(guarded, 1, {
    delayMs: 0,
    humanRestEnabled: false
  });
  const deterministicPress = mouseEvents.find((event) => event.type === "mousePressed");
  assert.ok(deterministicPress);
  assert.equal(Math.round(deterministicPress.x), 50);
  assert.equal(Math.round(deterministicPress.y), 20);
  assert.equal(deterministicClickBox.click_target.mode, "center");
  assert.equal(deterministicClickBox.click_result.mode, "direct");
}

async function testHumanRestController() {
  const sleepCalls = [];
  const disabled = createHumanRestController({ enabled: false });
  const disabledResult = await disabled.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  assert.equal(disabledResult.rested, false);
  assert.deepEqual(sleepCalls, []);

  const noRestFeatures = createHumanRestController({
    enabled: true,
    shortRestEnabled: false,
    batchRestEnabled: false,
    random: createSequenceRandom(Array.from({ length: 10 }, () => 0)),
    shortRestProbability: 1,
    batchThresholdBase: 1,
    batchThresholdJitter: 1
  });
  const noRestResult = await noRestFeatures.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  assert.equal(noRestResult.rested, false);
  assert.deepEqual(sleepCalls, []);

  const enabled = createHumanRestController({
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 20 }, () => 0)),
    shortRestProbability: 1,
    shortRestMinMs: 10,
    shortRestMaxMs: 10,
    batchThresholdBase: 2,
    batchThresholdJitter: 1,
    batchRestMinMs: 20,
    batchRestMaxMs: 20
  });
  const first = await enabled.takeBreakIfNeeded({ sleepFn: async (ms) => sleepCalls.push(ms) });
  const second = await enabled.takeBreakIfNeeded({ sleepFn: async (ms) => sleepCalls.push(ms) });
  assert.equal(first.rested, true);
  assert.equal(second.events.some((event) => event.kind === "batch_rest"), true);
  assert.deepEqual(sleepCalls, [10, 10, 20]);
  assert.equal(enabled.getState().rest_count, 3);
  assert.equal(enabled.getState().total_rest_ms, 40);

  sleepCalls.length = 0;
  const perCandidate = createHumanRestController({
    enabled: true,
    restLevel: "high",
    perCandidateRestEnabled: true,
    perCandidateRestMinMs: 5000,
    perCandidateRestMaxMs: 8000,
    random: createSequenceRandom([0, 0, 0.5, 1])
  });
  const perCandidateFirst = await perCandidate.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  const perCandidateSecond = await perCandidate.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  const perCandidateThird = await perCandidate.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  assert.equal(perCandidateFirst.rested, true);
  assert.equal(perCandidateFirst.events[0].kind, "per_candidate_rest");
  assert.equal(perCandidateSecond.events[0].kind, "per_candidate_rest");
  assert.equal(perCandidateThird.events[0].kind, "per_candidate_rest");
  assert.deepEqual(sleepCalls, [5000, 6500, 8000]);
  assert.equal(perCandidate.getState().processed_count, 3);
  assert.equal(perCandidate.getState().rest_count, 3);
  assert.equal(perCandidate.getState().total_rest_ms, 19500);
  assert.equal(perCandidate.getState().per_candidate_rest_enabled, true);
}

async function simulateBudgetRestLevel(restLevel, candidateActiveMs) {
  const sleepCalls = [];
  const events = [];
  let now = 0;
  const controller = createHumanRestController({
    enabled: true,
    restLevel,
    random: createPatternRandom(),
    nowFn: () => now
  });
  for (let index = 0; index < 700; index += 1) {
    now += candidateActiveMs;
    const result = await controller.takeBreakIfNeeded({
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      }
    });
    if (result.rested) events.push(...result.events);
  }
  return {
    state: controller.getState(),
    sleepCalls,
    events
  };
}

async function testHumanRestControllerBudgetLevels() {
  const medium = await simulateBudgetRestLevel("medium", 25000);
  assert.ok(Math.abs(medium.state.total_rest_ms - 30 * 60 * 1000) <= 90000);
  assert.ok(medium.events.length >= 25);
  assert.ok(new Set(medium.events.map((event) => event.processed_since_last_rest)).size > 3);
  assert.ok(new Set(medium.sleepCalls).size > 10);
  assert.ok(medium.events.some((event) => event.rest_size === "short"));
  assert.ok(medium.events.some((event) => event.rest_size === "long"));

  const high = await simulateBudgetRestLevel("high", 25000);
  assert.ok(Math.abs(high.state.total_rest_ms - 60 * 60 * 1000) <= 150000);
  assert.ok(high.events.length >= 35);
  assert.ok(new Set(high.events.map((event) => event.processed_since_last_rest)).size > 3);
  assert.ok(new Set(high.sleepCalls).size > 10);
  assert.ok(high.events.some((event) => event.rest_size === "short"));
  assert.ok(high.events.some((event) => event.rest_size === "long"));

  let now = 0;
  const clockDriven = createHumanRestController({
    enabled: true,
    restLevel: "medium",
    random: createSequenceRandom(Array.from({ length: 20 }, () => 0.5)),
    nowFn: () => now
  });
  now += 5 * 60 * 60 * 1000;
  const result = await clockDriven.takeBreakIfNeeded({ sleepFn: async () => {} });
  assert.equal(result.rested, true);
  assert.ok(result.events[0].rest_budget_debt_ms >= 30 * 60 * 1000);
}

async function testBossLoginDomDetection() {
  const queriedSelectors = [];
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelector({ selector }) {
        queriedSelectors.push(selector);
        return { nodeId: selector === ".login-box" ? 2 : 0 };
      },
      async getOuterHTML() {
        return { outerHTML: '<main><div class="login-box">扫码登录 Boss登录</div></main>' };
      }
    }
  };
  const state = await detectBossLoginState(client, {
    currentUrl: "https://www.zhipin.com/web/chat/recommend"
  });
  assert.equal(state.requires_login, true);
  assert.equal(state.reason, "dom");
  assert.ok(state.matched_selectors.includes(".login-box"));
  assert.ok(queriedSelectors.length > 0);
}

testForbiddenCdpConfigurationWithoutExecutingMethods();
await testAllowedDomainsAreLogged();
await testGuardedClientReconnectsClosedTransport();
await testGuardedClientDoesNotReplayScreenshot();
await testGuardedClientDoesNotReplayStateChangingOrUnknownMethods();
await testGuardedClientCanExplicitlyAbandonAndReconnect();
await testGuardedClientAnnotatesCdpNodeErrors();
await testNodeHelpersPreserveGuardedCdpDiagnostics();
await testUnexpectedDomainIsRejected();
testBossLoginUrlDetection();
testBossLoginRequiredErrorShape();
testChromeDebugUnavailableDetection();
testBossChromeLaunchArgsContainRequiredFlagsOnce();
testChromeRequiredFlagDetection();
await testEnsureChromeDebugPortLaunchesWhenMissing();
await testEnsureChromeDebugPortReusesCompliantChrome();
await testEnsureChromeDebugPortReplacesNoncompliantLocalChrome();
await testEnsureChromeDebugPortReplacesUnknownLocalChrome();
await testEnsureChromeDebugPortRejectsNonLocalMissingFlags();
await testConnectToChromeTargetOrOpenRunsGuardForBossTargets();
testHumanDelayAndBezierPath();
await testSimulateHumanClickUsesOnlyInputCdp();
await testConfiguredHumanInteractionControlsClickPoint();
testHumanBehaviorNormalization();
await testHumanClickPointAndChunkedText();
await testHumanRestController();
await testHumanRestControllerBudgetLevels();
await testBossLoginDomDetection();

console.log("CDP browser guard tests passed");
