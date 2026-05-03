export const RECRUIT_TARGET_URL = "https://www.zhipin.com/web/chat/search";

export const RECRUIT_IFRAME_SELECTORS = Object.freeze([
  'iframe[name="searchFrame"]',
  'iframe[src*="/web/frame/search/"]',
  "iframe"
]);

export const RECRUIT_CARD_SELECTOR = [
  "li.geek-info-card a[data-jid]",
  "li.geek-info-card a[data-geekid]",
  ".geek-info-card a[data-jid]",
  ".geek-info-card a[data-geekid]",
  ".geek-info-card a",
  "a[data-jid]",
  "a[data-geekid]"
].join(", ");

export const RECRUIT_NO_DATA_SELECTORS = Object.freeze([
  "i.tip-nodata",
  ".tip-nodata",
  ".empty-tip",
  ".empty-text",
  '[class*="empty"]'
]);

export const RECRUIT_BOTTOM_MARKER_SELECTORS = Object.freeze([
  ".finished-wrap",
  ".load-tips",
  ".tip-nodata",
  ".empty-tip",
  ".empty-text",
  ".no-data",
  "[class*=\"finished\"]",
  "[class*=\"load-tips\"]",
  "[class*=\"empty\"]"
]);

export const RECRUIT_BOTTOM_REFRESH_SELECTORS = Object.freeze([
  ".finished-wrap .btn-refresh",
  ".finished-wrap .btn",
  ".no-data-refresh .btn-refresh",
  ".no-data-refresh .btn",
  "[class*=\"refresh\"]",
  "[ka*=\"refresh\"]",
  "button",
  "a"
]);

export const RECRUIT_SEARCH_SELECTORS = Object.freeze({
  keywordInput: [
    "input.search-input",
    ".search-box input",
    ".search-wrap input",
    'input[placeholder*="搜索"]',
    "input"
  ],
  searchButton: [
    ".icon-search",
    ".search-btn",
    'button[ka*="search"]',
    '[class*="search"][class*="btn"]'
  ],
  jobTitleOption: [
    '.search-job-list-C li[ka="search_select_job"]',
    ".search-job-list-C li",
    '[ka="search_select_job"]'
  ],
  degreeOption: [
    ".degree-list-C .degree-item",
    ".degree-list-C li",
    ".degree-item",
    '[ka*="degree"]'
  ],
  schoolItem: [
    ".school-item",
    ".school-list-C .school-item",
    ".school-list-C li",
    '[class*="school"][class*="item"]'
  ],
  schoolClickable: [
    "label.checkbox",
    "label",
    ".checkbox",
    ".checkbox-text"
  ],
  recentViewedLabel: [
    'label.checkbox.high_search_checkbox[ka="search_change_view_resume"]',
    "label.checkbox.high_search_checkbox",
    "label.checkbox",
    '[ka="search_change_view_resume"]'
  ],
  cityInput: [
    ".city-wrap .search-city-kw input",
    ".search-city-kw input",
    ".city-wrap input",
    'input[placeholder*="城市"]'
  ],
  citySearchResult: [
    ".city-box .search-result-C .search-result-item",
    ".search-result-C .search-result-item",
    ".city-box li",
    ".dropdown-city li"
  ],
  cityProvinceItem: [
    ".dropdown-province li"
  ],
  cityDropdownItem: [
    ".dropdown-city li"
  ]
});

export const RECRUIT_DETAIL_POPUP_SELECTORS = Object.freeze([
  ".dialog-wrap.active",
  ".boss-popup__wrapper",
  ".boss-popup_wrapper",
  ".boss-dialog_wrapper",
  ".boss-dialog",
  ".resume-item-detail",
  ".geek-detail-modal",
  ".resume-container",
  '[class*="popup"][class*="wrapper"]',
  '[class*="dialog"][class*="wrapper"]'
]);

export const RECRUIT_DETAIL_RESUME_IFRAME_SELECTORS = Object.freeze([
  'iframe[src*="/web/frame/c-resume/"]',
  'iframe[name*="resume"]'
]);

export const RECRUIT_DETAIL_CLOSE_SELECTORS = Object.freeze([
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

export const RECRUIT_DETAIL_NETWORK_PATTERNS = Object.freeze([
  /\/wapi\/zpitem\/web\/boss\/search\/geek\/info\b/i,
  /\/wapi\/zpjob\/view\/geek\/info(?:\/v2)?\b/i,
  /\/wapi\/zpitem\/web\/boss\/[^?#]*\/geek\/info\b/i,
  /\/boss\/[^?#]*\/geek\/info\b/i,
  /\/geek\/info\b/i,
  /\/web\/frame\/c-resume\//i,
  /resume/i
]);
