export const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";

export const RECOMMEND_PAGE_SCOPE_DEFAULT = "recommend";

export const RECOMMEND_PAGE_SCOPE_STATUS = Object.freeze({
  recommend: "0",
  latest: "1",
  featured: "3"
});

export const RECOMMEND_PAGE_SCOPE_LABELS = Object.freeze({
  recommend: "推荐",
  latest: "最新",
  featured: "精选"
});

export const RECOMMEND_IFRAME_SELECTORS = Object.freeze([
  'iframe[name="recommendFrame"]',
  'iframe[src*="/web/frame/recommend/"]',
  "iframe"
]);

export const RECOMMEND_PAGE_SCOPE_TAB_SELECTOR = [
  ".tab-list .tab-item[data-status]",
  ".tab-wrap .tab-item[data-status]",
  ".tab-item[data-status]",
  "[data-status]"
].join(", ");

export const RECOMMEND_FILTER_SELECTORS = Object.freeze({
  trigger: ".filter-label-wrap",
  panel: ".filter-panel",
  groups: Object.freeze({
    activity: [
      ".filter-panel .check-box.activation",
      ".filter-panel .check-box.activity",
      ".filter-panel .check-box.activeTime",
      ".filter-panel .check-box.activityLevel",
      ".filter-panel .check-box.activity-level"
    ].join(", "),
    recentNotView: ".filter-panel .check-box.recentNotView",
    degree: ".filter-panel .check-box.degree",
    gender: ".filter-panel .check-box.gender",
    school: ".filter-panel .check-box.school"
  }),
  option: ".default.option, .options .option, .option",
  activeOption: ".default.option.active, .options .option.active, .option.active",
  confirmButton: ".filter-panel .btn, .filter-panel button",
  checkBox: ".filter-panel .check-box"
});

export const RECOMMEND_FILTER_GROUP_ORDER = Object.freeze([
  "recentNotView",
  "degree",
  "gender",
  "school",
  "activity"
]);

export const RECOMMEND_ACTIVITY_GROUP = "activity";

export const RECOMMEND_ACTIVITY_GROUP_HEADING = "活跃度[单选]";

export const RECOMMEND_ACTIVITY_LEVELS = Object.freeze([
  "不限",
  "刚刚活跃",
  "今日活跃",
  "3日内活跃",
  "本周活跃",
  "本月活跃"
]);

export const RECOMMEND_CURRENT_CITY_ONLY_LABEL = "仅推荐期望城市为本城市的牛人";

export const RECOMMEND_LOCATION_SELECTORS = Object.freeze({
  trigger: [
    ".city-or-area-name",
    ".city-selecter-wrap",
    ".city-selector-wrap",
    ".location-selecter-wrap",
    ".location-selector-wrap",
    ".city-select",
    ".location-select",
    ".recommend-city",
    ".recommend-location",
    '[class*="city-select"]',
    '[class*="location-select"]',
    '[class*="recommend-city"]'
  ],
  popoverCandidates: [
    ".check-area-warp",
    ".check-area-bottom"
  ].join(", "),
  checkboxCalibrated: [
    ".check-area-warp label.checkbox",
    ".check-area-bottom label.checkbox",
    ".check-area-warp .my-checkbox"
  ].join(", "),
  checkboxCandidates: [
    "label",
    '[role="checkbox"]',
    "input[type=\"checkbox\"]",
    ".checkbox",
    ".check-box",
    '[class*="checkbox"]',
    '[class*="check-box"]',
    "span"
  ].join(", "),
  checkboxInput: 'input[type="checkbox"], [role="checkbox"]',
  confirmCandidates: [
    '[class*="city"] button',
    '[class*="city"] .btn',
    '[class*="location"] button',
    '[class*="location"] .btn',
    "button",
    ".btn",
    '[role="button"]'
  ].join(", ")
});

export const RECOMMEND_RECENT_NOT_VIEW_LABEL = "近14天没有";

export const RECOMMEND_CARD_SELECTOR = [
  ".candidate-card-wrap .card-inner[data-geek]",
  ".candidate-card-wrap [data-geek]",
  "li.geek-info-card a[data-geekid]",
  "a[data-geekid]"
].join(", ");

export const RECOMMEND_LIST_CONTAINER_SELECTORS = Object.freeze([
  ".recommend-list",
  ".recommend-list-wrap",
  ".candidate-list",
  ".candidate-card-list",
  ".candidate-card-wrap-list",
  ".geek-list",
  ".geek-list-wrap",
  ".card-list",
  ".list-wrap",
  ".content-list"
]);

export const RECOMMEND_END_REFRESH_SELECTOR = [
  ".btn",
  "button",
  '[role="button"]',
  '[class*="refresh"]',
  '[ka*="refresh"]',
  "a"
].join(", ");

export const RECOMMEND_BOTTOM_MARKER_SELECTORS = Object.freeze([
  ".finished-wrap",
  ".no-data-refresh",
  ".load-tips",
  ".empty-tip",
  ".empty-text",
  ".no-data",
  "[class*=\"finished\"]",
  "[class*=\"load-tips\"]"
]);

export const DETAIL_POPUP_SELECTORS = Object.freeze([
  ".dialog-wrap.active",
  ".boss-popup__wrapper",
  ".boss-popup_wrapper",
  ".boss-dialog_wrapper",
  ".boss-dialog",
  ".resume-item-detail",
  ".geek-detail-modal",
  '[class*="popup"][class*="wrapper"]',
  '[class*="dialog"][class*="wrapper"]'
]);

export const DETAIL_RESUME_IFRAME_SELECTORS = Object.freeze([
  'iframe[src*="/web/frame/c-resume/"]',
  'iframe[name*="resume"]'
]);

export const RECOMMEND_AVATAR_PREVIEW_SELECTORS = Object.freeze([
  ".boss-dialog__wrapper.avatar-preview",
  ".avatar-preview",
  ".dialog-wrap.active .avatar-preview",
  ".figure-preview"
]);

export const RECOMMEND_AVATAR_PREVIEW_CLOSE_SELECTORS = Object.freeze([
  ".avatar-preview .boss-popup__close",
  ".dialog-wrap.active .avatar-preview .boss-popup__close",
  ".dialog-wrap.active .boss-popup__close",
  ".boss-dialog__wrapper.avatar-preview .boss-popup__close",
  ".boss-popup__close",
  ".icon-close",
  '[class*="close"]'
]);

export const DETAIL_CLOSE_SELECTORS = Object.freeze([
  ".boss-popup__close",
  ".popup-close",
  ".modal-close",
  ".dialog-close",
  ".close-btn",
  'button[aria-label*="关闭"]',
  'button[title*="关闭"]',
  ".icon-close",
  '[aria-label*="关闭"]',
  '[title*="关闭"]',
  '[class*="close"]'
]);

export const DETAIL_NETWORK_PATTERNS = Object.freeze([
  /\/wapi\/zpjob\/view\/geek\/info\b/i,
  /\/wapi\/zpitem\/web\/boss\/[^?#]*\/geek\/info\b/i,
  /\/boss\/[^?#]*\/geek\/info\b/i,
  /\/geek\/info\b/i,
  /\/web\/frame\/c-resume\//i,
  /resume/i
]);

export const FAVORITE_BUTTON_SELECTORS = Object.freeze([
  ".like-icon-and-text",
  ".resume-footer.item-operate [class*=\"collect\"]",
  ".resume-footer.item-operate [class*=\"favorite\"]",
  ".resume-footer.item-operate [class*=\"like\"]",
  ".resume-footer-wrap [class*=\"collect\"]",
  ".resume-footer-wrap [class*=\"favorite\"]",
  ".resume-footer-wrap [class*=\"like\"]",
  ".resume-footer [class*=\"collect\"]",
  ".resume-footer [class*=\"favorite\"]",
  ".resume-footer [class*=\"like\"]",
  ".resume-footer.item-operate button",
  ".resume-footer.item-operate .btn",
  ".resume-footer.item-operate span",
  ".resume-footer-wrap button",
  ".resume-footer-wrap .btn",
  ".resume-footer-wrap span",
  ".resume-footer button",
  ".resume-footer .btn",
  ".resume-footer span"
]);

export const GREET_BUTTON_RECOMMEND_SELECTORS = Object.freeze([
  "button.btn-v2.btn-sure-v2.btn-greet",
  ".resume-footer.item-operate button.btn-v2",
  ".resume-footer-wrap button.btn-v2",
  ".resume-footer.item-operate button",
  ".resume-footer-wrap button",
  ".resume-footer button",
  "button[class*=\"greet\"]",
  "button[class*=\"sure\"]"
]);
