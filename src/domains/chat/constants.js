export const CHAT_TARGET_URL = "https://www.zhipin.com/web/chat/index";

export const CHAT_CARD_SELECTORS = Object.freeze([
  ".geek-item[data-id]",
  "div[role=\"listitem\"] .geek-item[data-id]",
  ".geek-item",
  ".geek-item-wrap",
  "div[role=\"listitem\"]"
]);

export const CHAT_LIST_CONTAINER_SELECTORS = Object.freeze([
  ".chat-list",
  ".chat-list-content",
  ".chat-left",
  ".chat-left-main",
  ".chat-message-list-left",
  ".chat-conversation-list",
  ".geek-list",
  ".geek-list-wrap",
  ".chat-list-wrap",
  ".user-list",
  ".conversation-list",
  "div[role=\"list\"]"
]);

export const CHAT_BOTTOM_MARKER_SELECTORS = Object.freeze([
  "div[role=\"tfoot\"] .load-tips",
  "p.load-tips",
  ".load-tips",
  ".empty-tip",
  ".empty-text",
  ".no-data",
  "[class*=\"load-tips\"]",
  "[class*=\"empty\"]"
]);

export const CHAT_JOB_LABEL_SELECTORS = Object.freeze([
  ".chat-job .chat-select-job",
  ".chat-job .dropmenu-label",
  ".chat-top-job .ui-dropmenu-label",
  ".job-select .ui-dropmenu-label"
]);

export const CHAT_JOB_OPTION_SELECTORS = Object.freeze([
  ".chat-job .ui-dropmenu-list li",
  ".chat-top-job .ui-dropmenu-list li",
  ".job-select .ui-dropmenu-list li",
  ".chat-job li[value]"
]);

export const CHAT_JOB_TRIGGER_SELECTORS = Object.freeze([
  ".chat-job .chat-select-job",
  ".chat-job .dropmenu-label",
  ".chat-job",
  ".chat-top-job .ui-dropmenu-label",
  ".job-select .ui-dropmenu-label",
  ".chat-job-select",
  ".chat-job-selector",
  ".job-selecter",
  ".job-selector",
  ".job-select-wrap",
  ".job-select-box",
  ".job-wrap",
  ".chat-job-name",
  ".top-chat-search"
]);

export const CHAT_JOB_FALLBACK_SELECTORS = Object.freeze([
  ".source-job[title]",
  ".source-job"
]);

export const CHAT_ACTIVE_CANDIDATE_SELECTORS = Object.freeze([
  ".geek-item.selected[data-id]",
  ".geek-item.selected",
  ".geek-item.active[data-id]",
  ".geek-item.active"
]);

export const CHAT_PRIMARY_LABEL_SELECTORS = Object.freeze([
  ".label-list .chat-label-item",
  ".chat-label-item"
]);

export const CHAT_MESSAGE_FILTER_SELECTORS = Object.freeze([
  ".chat-message-filter-left span",
  ".chat-message-filter-left [class*=\"item\"]",
  ".chat-message-filter span",
  ".chat-message-filter [class*=\"item\"]",
  '[role="tab"]',
  "button",
  "span"
]);

export const CHAT_ONLINE_RESUME_BUTTON_SELECTORS = Object.freeze([
  "a.btn.resume-btn-online",
  "a.resume-btn-online",
  ".btn.resume-btn-online",
  ".resume-btn-online"
]);

export const CHAT_ATTACHMENT_RESUME_BUTTON_SELECTORS = Object.freeze([
  ".resume-btn-file",
  ".btn.resume-btn-file",
  '[class*="resume-btn-file"]'
]);

export const CHAT_ASK_RESUME_BUTTON_SELECTORS = Object.freeze([
  "span.operate-btn",
  ".operate-btn",
  '[class*="operate"]',
  '[class*="resume"]',
  "button",
  "a",
  "span"
]);

export const CHAT_EDITOR_SELECTORS = Object.freeze([
  "#boss-chat-editor-input",
  ".conversation-editor #boss-chat-editor-input",
  ".conversation-editor .boss-chat-editor-input",
  '[contenteditable="true"]',
  "textarea"
]);

export const CHAT_SEND_BUTTON_SELECTORS = Object.freeze([
  ".conversation-editor .submit.active",
  ".conversation-editor .submit-content .submit.active",
  ".submit.active",
  ".conversation-editor .submit-content .submit",
  ".conversation-editor .submit",
  ".submit-content .submit",
  ".submit"
]);

export const CHAT_CONFIRM_REQUEST_RESUME_SELECTORS = Object.freeze([
  "span.boss-btn-primary.boss-btn",
  ".boss-btn-primary.boss-btn",
  ".boss-popup__wrapper .boss-btn-primary",
  ".boss-dialog .boss-btn-primary",
  ".boss-btn-primary",
  "button",
  "a",
  "span"
]);

export const CHAT_MESSAGE_LIST_SELECTORS = Object.freeze([
  ".chat-message-list",
  ".message-list",
  ".chat-record",
  ".conversation-message-list"
]);

export const CHAT_RESUME_MODAL_SELECTORS = Object.freeze([
  ".boss-popup__wrapper",
  ".new-chat-resume-dialog-main-ui",
  ".dialog-wrap.active",
  ".boss-dialog",
  ".geek-detail-modal",
  ".modal",
  ".resume-container",
  ".resume-content-wrap",
  ".resume-common-wrap",
  ".resume-detail",
  ".resume-recommend"
]);

export const CHAT_RESUME_FAST_MODAL_SELECTORS = Object.freeze([
  ".boss-popup__wrapper.new-chat-resume-dialog-main-ui",
  ".new-chat-resume-dialog-main-ui",
  ".resume-common-dialog.search-resume",
  ".resume-recommend",
  'iframe[src*="/web/frame/c-resume/"]'
]);

export const CHAT_RESUME_CONTENT_SELECTORS = Object.freeze([
  ".resume-center-side .resume-detail-wrap",
  ".resume-detail-wrap",
  ".resume-content-wrap",
  ".resume-common-wrap",
  ".resume-detail",
  ".resume-recommend",
  ".new-resume-online-main-ui",
  ".new-chat-resume-dialog-main-ui",
  "canvas#resume"
]);

export const CHAT_RESUME_IFRAME_SELECTORS = Object.freeze([
  'iframe[src*="/web/frame/c-resume/"]',
  'iframe[src*="resume"]',
  'iframe[name*="resume"]'
]);

export const CHAT_RESUME_CLOSE_SELECTORS = Object.freeze([
  ".boss-popup__close",
  ".boss-dialog__close",
  ".new-chat-resume-dialog-main-ui .boss-popup__close",
  ".new-chat-resume-dialog-main-ui .icon-close",
  ".new-chat-resume-dialog-main-ui [class*=\"close\"]",
  ".boss-popup__wrapper [class*=\"close\"]",
  ".boss-dialog [class*=\"close\"]",
  ".popup-close",
  ".modal-close",
  ".dialog-close",
  ".close-btn",
  ".icon-close",
  '[aria-label*="关闭"]',
  '[title*="关闭"]'
]);

export const CHAT_BLOCKING_PANEL_TEXT_QUERIES = Object.freeze([
  "我的权益",
  "VVIP账号-精选版专享权益",
  "全部账号权益使用量",
  "职位发布权益总量",
  "每日使用权益总量"
]);

export const CHAT_BLOCKING_PANEL_CLOSE_SELECTORS = Object.freeze([
  ".boss-popup__close",
  ".boss-dialog__close",
  ".side-panel-close",
  ".drawer-close",
  ".panel-close",
  ".popup-close",
  ".modal-close",
  ".dialog-close",
  ".close-btn",
  ".icon-close",
  "[class*=\"close\"]",
  '[aria-label*="关闭"]',
  '[title*="关闭"]'
]);

export const CHAT_PROFILE_NETWORK_PATTERNS = Object.freeze([
  /\/wapi\/zpjob\/view\/geek\/info(?:\/v2)?\b/i,
  /\/wapi\/zpjob\/chat\/geek\/info\b/i,
  /\/wapi\/zpchat\/boss\/historyMsg\b/i,
  /\/wapi\/zpchat\/session\/bossEnter\b/i,
  /\/wapi\/zpitem\/web\/boss\/[^?#]*\/geek\/info\b/i,
  /\/boss\/[^?#]*\/geek\/info\b/i,
  /\/geek\/info\b/i,
  /\/web\/frame\/c-resume\//i,
  /resume/i
]);
