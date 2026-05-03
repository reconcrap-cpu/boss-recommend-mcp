import {
  getMainFrameUrl,
  waitForMainFrameUrl
} from "../../core/browser/index.js";
import { CHAT_TARGET_URL } from "./constants.js";

export const CHAT_FORBIDDEN_TOP_LEVEL_RESUME_CODE = "CHAT_FORBIDDEN_TOP_LEVEL_RESUME_NAVIGATION";

export function isChatShellUrl(url = "") {
  const value = String(url || "");
  return /https?:\/\/[^/]*zhipin\.com\/web\/chat\/index(?:[/?#]|$)/i.test(value)
    || /https?:\/\/[^/]*zhipin\.com\/web\/chat\/index$/i.test(value);
}

export function isForbiddenChatResumeTopLevelUrl(url = "") {
  return /https?:\/\/[^/]*zhipin\.com\/web\/frame\/c-resume\/?/i.test(String(url || ""));
}

export async function getChatTopLevelState(client) {
  let url = "";
  let error = null;
  try {
    url = await getMainFrameUrl(client);
  } catch (err) {
    error = err?.message || String(err);
  }
  return {
    url,
    is_chat_shell: isChatShellUrl(url),
    is_forbidden_resume_top_level: isForbiddenChatResumeTopLevelUrl(url),
    error
  };
}

export function makeForbiddenChatResumeNavigationError(pageState, message = "") {
  const error = new Error(message || `Chat tab navigated to forbidden top-level resume URL: ${pageState?.url || "unknown"}`);
  error.code = CHAT_FORBIDDEN_TOP_LEVEL_RESUME_CODE;
  error.page_state = pageState || null;
  return error;
}

export function isForbiddenChatResumeNavigationError(error) {
  return error?.code === CHAT_FORBIDDEN_TOP_LEVEL_RESUME_CODE
    || /CHAT_FORBIDDEN_TOP_LEVEL_RESUME_NAVIGATION/i.test(String(error?.message || error || ""));
}

export async function assertChatShellNotResumeTopLevel(client, {
  context = "chat"
} = {}) {
  const state = await getChatTopLevelState(client);
  if (state.is_forbidden_resume_top_level) {
    throw makeForbiddenChatResumeNavigationError(
      state,
      `CHAT_FORBIDDEN_TOP_LEVEL_RESUME_NAVIGATION during ${context}: ${state.url}`
    );
  }
  return state;
}

export async function recoverChatShell(client, {
  targetUrl = CHAT_TARGET_URL,
  timeoutMs = 60000,
  intervalMs = 500
} = {}) {
  const before = await getChatTopLevelState(client);
  if (before.is_chat_shell) {
    return {
      recovered: false,
      before,
      after: before,
      navigate_url: null
    };
  }

  await client.Page.navigate({ url: targetUrl });
  const waited = await waitForMainFrameUrl(client, isChatShellUrl, {
    timeoutMs,
    intervalMs
  });
  const after = await getChatTopLevelState(client);
  return {
    recovered: waited.ok && after.is_chat_shell,
    before,
    after,
    wait: waited,
    navigate_url: targetUrl
  };
}
