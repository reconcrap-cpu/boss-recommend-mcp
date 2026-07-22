import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  buildScreeningLlmImageInputs,
  buildScreeningCandidateFromDetail,
  buildScreeningLlmMessages,
  callScreeningLlm,
  classifyFatalLlmProviderError,
  compactScreeningLlmResult,
  createFatalLlmRunError,
  extractBossProfileFromNetworkBody,
  htmlToText,
  isFatalLlmProviderError,
  normalizeCandidateFromHtml,
  normalizeCandidateProfile,
  screenCandidate
} from "./core/screening/index.js";

function getPromptText(messages) {
  const userContent = messages?.[1]?.content;
  if (typeof userContent === "string") return userContent;
  return userContent?.find((item) => item?.type === "text")?.text || "";
}

function assertPromptHasFailFast(messages) {
  assert.equal(messages[0].content.includes("必须完整阅读输入内容"), false);
  assert.equal(messages[0].content.includes("一旦确定命中硬性淘汰项"), true);
  const promptText = getPromptText(messages);
  assert.equal(promptText.includes("按筛选标准原文顺序拆解并检查硬性淘汰项"), true);
  assert.equal(promptText.includes("一旦某项可确定不满足，必须立即返回 passed=false"), true);
  assert.equal(promptText.includes("这类缺失证据就是可确定不满足"), true);
  assert.equal(promptText.includes("可能被后续可见简历内容澄清"), true);
}

function assertPromptHasFastReviewCounterevidenceGuard(messages) {
  assert.equal(messages[0].content.includes("无可见反向证据"), true);
  const promptText = getPromptText(messages);
  assert.equal(promptText.includes("只有当某个硬性不通过条件有直接、明确、无可见反向证据"), true);
  assert.equal(promptText.includes("存在任何可能满足当前被否定条件的反向证据、边界证据或可计入经历"), true);
  assert.equal(promptText.includes("可能合格的产品或行业"), true);
  assert.equal(promptText.includes("可能合格的职责或指标"), true);
  assert.equal(promptText.includes("不要因为候选人其他经历不匹配，就忽略某一段可能匹配的经历"), true);
  assert.equal(promptText.includes("summary 必须点明确切的决定性硬性失败"), true);
}

function testHtmlToText() {
  const text = htmlToText("<div data-geek=\"abc\"><span>张三</span><br><b>本科</b>&nbsp;5年经验</div>");
  assert.equal(text.includes("张三"), true);
  assert.equal(text.includes("本科"), true);
  assert.equal(text.includes("5年经验"), true);
}

function testNormalizeFromHtml() {
  const candidate = normalizeCandidateFromHtml({
    domain: "recommend",
    source: "unit-fixture",
    html: "<a data-geek=\"abc123\" href=\"/web/geek/abc123\"><div>李四</div><div>本科 6年经验 男</div><div>前端 React TypeScript</div></a>"
  });
  assert.equal(candidate.domain, "recommend");
  assert.equal(candidate.id, "abc123");
  assert.equal(candidate.identity.name, "李四");
  assert.equal(candidate.identity.degree, "本科");
  assert.equal(candidate.identity.years_experience, 6);
  assert.equal(candidate.identity.gender, "男");
}

function testNormalizeFromHtmlSkipsSalaryAsName() {
  const candidate = normalizeCandidateFromHtml({
    domain: "recommend",
    source: "unit-fixture",
    html: "<div><span>15-30K</span><div>马良</div><div>21岁 27年应届生 本科</div></div>"
  });
  assert.equal(candidate.identity.name, "马良");
  assert.equal(candidate.identity.degree, "本科");
  assert.equal(candidate.identity.age, 21);
}

function testNormalizeProfile() {
  const candidate = normalizeCandidateProfile({
    domain: "chat",
    source: "fixture",
    id: "chat-1",
    text: "王五\n硕士 3年经验\nNode.js 后端"
  });
  assert.equal(candidate.domain, "chat");
  assert.equal(candidate.id, "chat-1");
  assert.equal(candidate.identity.name, "王五");
  assert.equal(candidate.identity.degree, "硕士");
}

function testScreenCandidate() {
  const candidate = normalizeCandidateProfile({
    domain: "recruit",
    source: "fixture",
    id: "recruit-1",
    text: "赵六\n硕士 8年经验\nMCP TypeScript Node.js"
  });
  const result = screenCandidate(candidate, {
    required_keywords: ["TypeScript"],
    preferred_keywords: ["MCP", "React"],
    minimum_degree: "本科"
  });
  assert.equal(result.passed, true);
  assert.equal(result.status, "pass");
  assert.equal(result.matched.required_keywords.includes("TypeScript"), true);
  assert.equal(result.matched.preferred_keywords.includes("MCP"), true);
  assert.equal(result.score > 0, true);
}

function testBossNetworkProfileExtraction() {
  const networkBody = {
    url: "https://www.zhipin.com/wapi/zpjob/view/geek/info",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: {
              name: "钱七",
              gender: 1,
              degreeCategory: "硕士",
              workYearDesc: "5年经验",
              ageDesc: "28岁",
              userDescription: "长期从事 TypeScript 与 MCP 工具开发"
            },
            geekWorkExpList: [
              {
                formattedCompany: "示例科技",
                positionName: "高级前端工程师",
                startYearMonStr: "2020.01",
                endYearMonStr: "至今",
                responsibility: "负责 MCP 平台与 TypeScript 工程化"
              }
            ],
            geekProjExpList: [
              {
                name: "Boss 自动化项目",
                roleName: "负责人",
                projectDescription: "使用 CDP DOM 和 Input 实现自动化"
              }
            ],
            geekEduExpList: [
              {
                school: "示例大学",
                major: "计算机科学",
                degreeName: "硕士",
                startDateDesc: "2016",
                endDateDesc: "2019",
                schoolTags: [{ name: "985" }]
              }
            ],
            geekCertificationList: [
              { certName: "PMP" }
            ]
          }
        }
      })
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.identity.name, "钱七");
  assert.equal(extracted.profile.identity.gender, "男");
  assert.equal(extracted.profile.identity.current_company, "示例科技");
  assert.equal(extracted.profile.identity.school, "示例大学");
  assert.equal(extracted.profile.text.includes("MCP 平台"), true);
  assert.equal(extracted.profile.source_keys.work_count, 1);
}

function testBossNetworkProfileExtractionFromGeekDetail() {
  const networkBody = {
    url: "https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          geekDetail: {
            geekBaseInfo: {
              name: "周九",
              gender: 2,
              degreeCategory: "博士",
              workYearDesc: "3年经验",
              ageDesc: "29岁",
              userDesc: "研究方向包括机器学习与推荐系统",
              userDescHighLightList: [{ name: "机器学习" }]
            },
            geekExpectList: [
              {
                positionName: "算法工程师",
                locationName: "上海",
                salaryDesc: "30-50K"
              }
            ],
            geekWorkExpList: [
              {
                company: "算法实验室",
                positionName: "算法研究员",
                startYearMonStr: "2022.07",
                endYearMonStr: "至今",
                responsibility: "负责推荐模型训练和线上特征工程"
              }
            ],
            geekProjExpList: [
              {
                name: "搜索排序项目",
                roleName: "核心开发",
                description: "优化召回和排序模型"
              }
            ],
            geekEduExpList: [
              {
                school: "示例理工大学",
                major: "人工智能",
                degreeName: "博士",
                startYearStr: "2017",
                endYearStr: "2022"
              }
            ]
          }
        }
      })
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.source_keys.geek_detail, true);
  assert.equal(extracted.profile.source_keys.geek_detail_info, false);
  assert.equal(extracted.profile.identity.name, "周九");
  assert.equal(extracted.profile.identity.gender, "女");
  assert.equal(extracted.profile.identity.degree, "博士");
  assert.equal(extracted.profile.identity.current_company, "算法实验室");
  assert.equal(extracted.profile.identity.school, "示例理工大学");
  assert.equal(extracted.profile.text.includes("推荐模型训练"), true);
  assert.equal(extracted.profile.text.includes("搜索排序项目"), true);
  assert.equal(extracted.profile.source_keys.expectation_count, 1);
}

function testBossNetworkProfileExtractionFromNestedData() {
  const networkBody = {
    url: "https://www.zhipin.com/wapi/zpjob/view/geek/info/v2",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          data: {
            payload: {
              profile: {
                geekBaseInfo: {
                  name: "嵌套候选人",
                  gender: 1,
                  degreeCategory: "硕士",
                  userDescription: "图像算法和多模态模型经验"
                },
                geekEduExpList: [
                  { school: "嵌套大学", major: "人工智能", degreeName: "硕士" }
                ],
                geekWorkExpList: [
                  { company: "视觉科技", positionName: "算法工程师", responsibility: "负责计算机视觉模型" }
                ]
              }
            }
          }
        }
      })
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.source_keys.recursive_profile_match, true);
  assert.equal(extracted.profile.identity.name, "嵌套候选人");
  assert.equal(extracted.profile.identity.school, "嵌套大学");
  assert.equal(extracted.profile.text.includes("计算机视觉模型"), true);
}

function testBossNetworkProfileExtractionFromHtmlEmbeddedJson() {
  const payload = {
    zpData: {
      geekDetailInfo: {
        geekBaseInfo: {
          name: "脚本候选人",
          degreeCategory: "博士"
        },
        geekEduExpList: [
          { school: "脚本大学", major: "计算机视觉", degreeName: "博士" }
        ]
      }
    }
  };
  const networkBody = {
    url: "https://www.zhipin.com/web/frame/c-resume/",
    status: 200,
    mimeType: "text/html",
    body: {
      body: `<html><script>window.__INITIAL_STATE__=${JSON.stringify(payload)};</script></html>`
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.identity.name, "脚本候选人");
  assert.equal(extracted.profile.identity.school, "脚本大学");
}

function testBossNetworkEncryptedResumeExplainsImageFallback() {
  const extracted = extractBossProfileFromNetworkBody({
    url: "https://www.zhipin.com/wapi/zpjob/view/geek/info/v2",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          geekDetailInfo: {},
          encryptGeekDetailInfo: "abc123encrypted",
          wasm: "1.0.2-5081"
        }
      })
    }
  });
  assert.equal(extracted.ok, false);
  assert.equal(extracted.error, "BOSS_GEEK_DETAIL_INFO_ENCRYPTED");
  assert.equal(extracted.encrypted_resume, true);
  assert.equal(extracted.encrypted_resume_length > 0, true);
}

function testBossChatGeekInfoExtraction() {
  const networkBody = {
    url: "https://www.zhipin.com/wapi/zpjob/chat/geek/info",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          data: {
            uid: 123,
            name: "吴十",
            year: "26年应届生",
            positionName: "数据分析师",
            lastCompany: "数据科技",
            lastPosition: "数据实习生",
            school: "示例财经大学",
            major: "统计学",
            degree: "硕士",
            highLightGeekResumeWords: ["Python", "SQL"],
            eduExpList: [
              { school: "示例财经大学", major: "统计学", degree: "硕士" }
            ],
            workExpList: [
              { company: "数据科技", positionName: "数据实习生", description: "负责用户行为分析" }
            ]
          }
        }
      })
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.source_keys.chat_geek_info, true);
  assert.equal(extracted.profile.identity.name, "吴十");
  assert.equal(extracted.profile.identity.school, "示例财经大学");
  assert.equal(extracted.profile.text.includes("用户行为分析"), true);
}

function testBossChatHistoryResumeExtraction() {
  const networkBody = {
    url: "https://www.zhipin.com/wapi/zpchat/boss/historyMsg",
    status: 200,
    mimeType: "application/json",
    body: {
      body: JSON.stringify({
        code: 0,
        zpData: {
          messages: [
            {
              body: {
                resume: {
                  position: "算法工程师",
                  workYear: "3年经验",
                  user: { name: "郑十一", company: "算法科技" },
                  education: [
                    { school: "示例大学", major: "计算机", degree: "本科" }
                  ],
                  experiences: [
                    { company: "算法科技", positionName: "算法工程师", description: "负责推荐模型训练" }
                  ]
                }
              }
            }
          ]
        }
      })
    }
  };
  const extracted = extractBossProfileFromNetworkBody(networkBody);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.profile.source_keys.chat_history_resume, true);
  assert.equal(extracted.profile.identity.name, "郑十一");
  assert.equal(extracted.profile.identity.current_company, "算法科技");
  assert.equal(extracted.profile.text.includes("推荐模型训练"), true);
}

function testBuildScreeningCandidateFromDetailUsesCleanNetworkText() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "card",
    id: "candidate-1",
    text: "钱七\n硕士 5年经验\nTypeScript"
  });
  const body = {
    body: {
      body: JSON.stringify({
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: {
              encryptGeekId: "candidate-1",
              name: "钱七",
              gender: 1,
              degreeCategory: "硕士",
              workYearDesc: "5年经验",
              ageDesc: "28岁"
            },
            geekEduExpList: [{ school: "示例大学", major: "计算机科学", degreeName: "硕士" }]
          }
        }
      })
    }
  };
  const built = buildScreeningCandidateFromDetail({
    cardCandidate,
    detailText: "详情页可见文本",
    networkBodies: [body]
  });
  assert.equal(built.candidate.identity.name, "钱七");
  assert.equal(built.candidate.identity.school, "示例大学");
  assert.equal(built.candidate.text.raw.includes("【基础信息】"), true);
  assert.equal(built.candidate.text.raw.includes("\"zpData\""), false);
  assert.equal(built.parsed_network_profiles.length, 1);
  assert.equal(built.parsed_network_profiles[0].ok, true);
  assert.equal(built.parsed_network_profiles[0].candidate_binding.verified, true);
  assert.equal(built.network_profile_binding.accepted_count, 1);
}

function testRecommendNetworkProfileRequiresExactCardIdAndName() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "card",
    id: "candidate-a",
    text: "朱余哲\n博士\n卡片可见经历",
    identity: {
      name: "朱余哲",
      current_company: "卡片公司"
    },
    tags: ["卡片标签"]
  });
  const exactBody = {
    url: "https://www.zhipin.com/wapi/zpjob/view/geek/info?encryptJid=candidate-a",
    body: {
      body: JSON.stringify({
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: {
              name: "朱余哲",
              userDescription: "网络精确绑定经历"
            },
            geekWorkExpList: [{ formattedCompany: "网络公司", positionName: "算法研究员" }],
            geekEduExpList: [{ school: "浙江大学", degreeName: "博士" }],
            geekSkillList: ["3DGS"]
          }
        }
      })
    }
  };
  const built = buildScreeningCandidateFromDetail({
    cardCandidate,
    detailText: "详情可见文本",
    networkBodies: [exactBody]
  });
  assert.equal(built.parsed_network_profiles[0].ok, true);
  assert.equal(built.parsed_network_profiles[0].candidate_binding.verified, true);
  assert.equal(
    built.parsed_network_profiles[0].candidate_binding.matched_candidate_id_source,
    "url_query:encryptjid"
  );
  assert.equal(built.candidate.id, "candidate-a");
  assert.equal(built.candidate.identity.name, "朱余哲");
  assert.equal(built.candidate.identity.current_company, "卡片公司");
  assert.equal(built.candidate.identity.school, "浙江大学");
  assert.equal(built.candidate.text.raw.includes("网络精确绑定经历"), true);
  assert.equal(built.candidate.tags.includes("3DGS"), true);
}

function testRecommendNetworkProfileMismatchIsFullyExcludedForImageFallback() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "card",
    id: "33e97f1cf19aef040XB73t-_FlJQ",
    text: "朱余哲\n博士\n卡片唯一文本",
    identity: { name: "朱余哲" },
    tags: ["卡片标签"]
  });
  const staleBodyWithoutCandidateId = {
    url: "https://www.zhipin.com/wapi/zpjob/view/geek/info",
    body: {
      body: JSON.stringify({
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: {
              name: "杨雯语",
              userDescription: "不应进入筛选的旧网络简历"
            },
            geekEduExpList: [{ school: "错误学校", degreeName: "博士" }],
            geekSkillList: ["错误网络标签"]
          }
        }
      })
    }
  };
  const built = buildScreeningCandidateFromDetail({
    cardCandidate,
    detailText: "当前详情页可见文本",
    networkBodies: [staleBodyWithoutCandidateId]
  });
  const rejected = built.parsed_network_profiles[0];
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "RECOMMEND_NETWORK_PROFILE_CANDIDATE_BINDING_UNVERIFIED");
  assert.equal(rejected.candidate_binding.reason, "network_candidate_id_evidence_missing");
  assert.equal(rejected.profile, undefined);
  assert.equal(built.network_profile_binding.accepted_count, 0);
  assert.equal(built.network_profile_binding.rejected_count, 1);
  assert.equal(built.candidate.id, "33e97f1cf19aef040XB73t-_FlJQ");
  assert.equal(built.candidate.identity.name, "朱余哲");
  assert.equal(built.candidate.identity.school, null);
  assert.equal(built.candidate.text.raw.includes("不应进入筛选的旧网络简历"), false);
  assert.equal(built.candidate.text.raw.includes("杨雯语"), false);
  assert.equal(built.candidate.tags.includes("错误网络标签"), false);
  const messages = buildScreeningLlmMessages({
    candidate: built.candidate,
    criteria: "必须有可见科研经历"
  });
  const promptText = getPromptText(messages);
  assert.equal(promptText.includes("不应进入筛选的旧网络简历"), false);
  assert.equal(promptText.includes("杨雯语"), false);
}

function testRecommendNetworkProfileRejectsWrongNameAndGenericUid() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "card",
    id: "candidate-a",
    text: "朱余哲\n博士",
    identity: { name: "朱余哲" }
  });
  const bodyFor = (baseInfo) => ({
    body: {
      body: JSON.stringify({
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: baseInfo,
            geekEduExpList: [{ school: "不可采信学校" }]
          }
        }
      })
    }
  });
  const wrongName = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [bodyFor({ encryptGeekId: "candidate-a", name: "杨雯语" })]
  });
  assert.equal(wrongName.parsed_network_profiles[0].ok, false);
  assert.equal(
    wrongName.parsed_network_profiles[0].candidate_binding.reason,
    "network_profile_name_mismatch"
  );
  assert.equal(wrongName.candidate.identity.name, "朱余哲");
  assert.equal(wrongName.candidate.identity.school, null);

  const wrongCandidateId = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [bodyFor({ encryptGeekId: "candidate-b", name: "朱余哲" })]
  });
  assert.equal(wrongCandidateId.parsed_network_profiles[0].ok, false);
  assert.equal(
    wrongCandidateId.parsed_network_profiles[0].candidate_binding.reason,
    "network_candidate_id_mismatch"
  );
  assert.deepEqual(
    wrongCandidateId.parsed_network_profiles[0].candidate_binding.observed_candidate_ids,
    ["candidate-b"]
  );
  assert.equal(wrongCandidateId.candidate.identity.school, null);

  const conflictingCandidateIds = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [{
      url: "https://www.zhipin.com/wapi/zpjob/view/geek/info?securityId=candidate-a",
      body: {
        body: JSON.stringify({
          zpData: {
            context: { encryptGeekId: "candidate-a" },
            geekDetailInfo: {
              geekBaseInfo: {
                encryptGeekId: "candidate-b",
                name: "朱余哲",
                userDescription: "同名B候选人污染正文"
              },
              geekEduExpList: [{ school: "同名B候选人学校" }]
            }
          }
        })
      }
    }]
  });
  assert.equal(conflictingCandidateIds.parsed_network_profiles[0].ok, false);
  assert.equal(
    conflictingCandidateIds.parsed_network_profiles[0].candidate_binding.reason,
    "network_candidate_id_conflict"
  );
  assert.deepEqual(
    conflictingCandidateIds.parsed_network_profiles[0].candidate_binding.observed_candidate_ids,
    ["candidate-a", "candidate-b"]
  );
  assert.equal(conflictingCandidateIds.candidate.text.raw.includes("同名B候选人污染正文"), false);
  assert.equal(conflictingCandidateIds.candidate.identity.school, null);

  const outerCandidateIdCannotAuthorizeIdlessProfile = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [{
      body: {
        body: JSON.stringify({
          zpData: {
            context: { encryptGeekId: "candidate-a" },
            geekDetailInfo: {
              geekBaseInfo: {
                name: "朱余哲",
                userDescription: "外层A授权不了无ID同名B正文"
              },
              geekEduExpList: [{ school: "无ID同名B学校" }]
            }
          }
        })
      }
    }]
  });
  const outerRejected = outerCandidateIdCannotAuthorizeIdlessProfile.parsed_network_profiles[0];
  assert.equal(outerRejected.ok, false);
  assert.equal(outerRejected.candidate_binding.reason, "network_candidate_id_evidence_missing");
  assert.deepEqual(outerRejected.candidate_binding.observed_candidate_ids, []);
  assert.deepEqual(outerRejected.candidate_binding.response_observed_candidate_ids, ["candidate-a"]);
  assert.equal(
    outerCandidateIdCannotAuthorizeIdlessProfile.candidate.text.raw.includes(
      "外层A授权不了无ID同名B正文"
    ),
    false
  );
  assert.equal(outerCandidateIdCannotAuthorizeIdlessProfile.candidate.identity.school, null);

  const genericUidOnly = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [bodyFor({ uid: "candidate-a", name: "朱余哲" })]
  });
  assert.equal(genericUidOnly.parsed_network_profiles[0].ok, false);
  assert.equal(
    genericUidOnly.parsed_network_profiles[0].candidate_binding.reason,
    "network_candidate_id_evidence_missing"
  );

  const placeholderName = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [bodyFor({ encryptGeekId: "candidate-a", name: "求职者" })]
  });
  assert.equal(placeholderName.parsed_network_profiles[0].ok, false);
  assert.equal(
    placeholderName.parsed_network_profiles[0].candidate_binding.reason,
    "network_profile_name_placeholder_or_missing"
  );
}

function testRecommendMixedNetworkBatchUsesOnlyExactBoundProfile() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "card",
    id: "candidate-a",
    text: "朱余哲\n博士",
    identity: { name: "朱余哲" }
  });
  const networkBody = ({ candidateId, name, marker, skill }) => ({
    body: {
      body: JSON.stringify({
        zpData: {
          geekDetailInfo: {
            geekBaseInfo: {
              encryptGeekId: candidateId,
              name,
              userDescription: marker
            },
            geekSkillList: [skill]
          }
        }
      })
    }
  });
  const built = buildScreeningCandidateFromDetail({
    cardCandidate,
    networkBodies: [
      networkBody({
        candidateId: "candidate-b",
        name: "杨雯语",
        marker: "B候选人旧网络正文",
        skill: "B候选人旧标签"
      }),
      networkBody({
        candidateId: "candidate-a",
        name: "朱余哲",
        marker: "A候选人精确网络正文",
        skill: "A候选人精确标签"
      })
    ]
  });
  assert.deepEqual(built.parsed_network_profiles.map((item) => item.ok), [false, true]);
  assert.equal(built.network_profile_binding.accepted_count, 1);
  assert.equal(built.network_profile_binding.rejected_count, 1);
  assert.equal(built.candidate.text.raw.includes("A候选人精确网络正文"), true);
  assert.equal(built.candidate.text.raw.includes("B候选人旧网络正文"), false);
  assert.equal(built.candidate.tags.includes("A候选人精确标签"), true);
  assert.equal(built.candidate.tags.includes("B候选人旧标签"), false);
}

function testNonRecommendNetworkProfileCompatibilityIsPreserved() {
  const cardCandidate = normalizeCandidateProfile({
    domain: "recruit",
    source: "card",
    id: "recruit-candidate",
    text: "招聘候选人",
    identity: { name: "招聘候选人" }
  });
  const built = buildScreeningCandidateFromDetail({
    domain: "recruit",
    cardCandidate,
    networkBodies: [{
      body: {
        body: JSON.stringify({
          zpData: {
            geekDetailInfo: {
              geekBaseInfo: { name: "招聘候选人" },
              geekEduExpList: [{ school: "兼容学校" }]
            }
          }
        })
      }
    }]
  });
  assert.equal(built.parsed_network_profiles[0].ok, true);
  assert.equal(built.candidate.identity.school, "兼容学校");
  assert.equal(built.network_profile_binding, null);
}

function testBuildScreeningLlmMessages() {
  const candidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "fixture",
    id: "candidate-2",
    text: "孙八\n本科\nCDP DOM 自动化"
  });
  const messages = buildScreeningLlmMessages({
    candidate,
    criteria: "有 CDP 自动化经验"
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content.includes("有 CDP 自动化经验"), true);
  assert.equal(messages[1].content.includes("CDP DOM 自动化"), true);
  assert.equal(messages[1].content.includes("\"passed\""), true);
  assert.equal(messages[1].content.includes("\"reason\""), false);
  assert.equal(messages[1].content.includes("\"evidence\""), false);
  assertPromptHasFailFast(messages);
}

function testBuildScreeningLlmMessagesFailFastForAllThinkingModes() {
  const candidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "fixture",
    id: "candidate-fail-fast",
    text: "赵六\n本科\n用户运营"
  });
  for (const thinkingLevel of ["current", "auto", "off", "minimal", "low", "medium", "high"]) {
    const messages = buildScreeningLlmMessages({
      candidate,
      criteria: "必须满足全部硬条件；证据不足一律 passed=false",
      thinkingLevel
    });
    assertPromptHasFailFast(messages);
    assert.equal(getPromptText(messages).includes("无可见反向证据"), false);
  }
}

function testBuildScreeningLlmMessagesFastFirstRequiresReviewOnCounterevidence() {
  const candidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "fixture",
    id: "candidate-counterevidence",
    text: [
      "候选人：潘新宇式混合经历",
      "EcoFlow 硬件配套 App 运营",
      "Boomplay DAU 千万级音乐流媒体产品，负责用户运营、消息推送、A/B test、FCM",
      "短剧/网文数据产品，负责产品运营和数据分析"
    ].join("\n")
  });
  const messages = buildScreeningLlmMessages({
    candidate,
    criteria: "筛选海外 prosumer 软件用户增长负责人。若产品/行业不匹配或用户数量增长责任证据不足，passed=false。",
    thinkingLevel: "current",
    requireReviewDecision: true
  });
  assertPromptHasFailFast(messages);
  assertPromptHasFastReviewCounterevidenceGuard(messages);
  const promptText = getPromptText(messages);
  assert.equal(promptText.includes("\"review_required\""), true);
  assert.equal(promptText.includes("Boomplay DAU 千万级音乐流媒体产品"), true);
}

function testBuildScreeningLlmMessagesWithImages() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-screening-images-"));
  const imagePath = path.join(dir, "page-01.png");
  fs.writeFileSync(imagePath, Buffer.from("fake-image"));
  const candidate = normalizeCandidateProfile({
    domain: "chat",
    source: "fixture-image",
    id: "candidate-image-1",
    text: ""
  });
  const imageInputs = buildScreeningLlmImageInputs({
    imagePaths: [imagePath],
    maxImages: 1
  });
  const messages = buildScreeningLlmMessages({
    candidate,
    criteria: "具备数据分析经验",
    imageInputs
  });
  assert.equal(imageInputs.length, 1);
  assert.equal(messages[1].content[0].type, "text");
  assert.equal(messages[1].content[0].text.includes("简历截图共 1 张"), true);
  assert.equal(messages[1].content[0].text.includes("明确硬性淘汰项，可停止后续评估"), true);
  assert.equal(messages[1].content[1].type, "image_url");
  assert.equal(messages[1].content[1].image_url.url.startsWith("data:image/png;base64,"), true);
  assertPromptHasFailFast(messages);
  fs.rmSync(dir, { recursive: true, force: true });
}

function testBuildScreeningLlmImageInputsPrefersComposedFullCvImages() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-screening-images-"));
  const sourcePaths = [
    path.join(dir, "page-01.jpg"),
    path.join(dir, "page-02.jpg"),
    path.join(dir, "page-03.jpg")
  ];
  const llmPaths = [
    path.join(dir, "page-llm-01.jpg"),
    path.join(dir, "page-llm-02.jpg")
  ];
  for (const imagePath of [...sourcePaths, ...llmPaths]) {
    fs.writeFileSync(imagePath, Buffer.from("fake-image"));
  }
  const imageInputs = buildScreeningLlmImageInputs({
    imageEvidence: {
      file_paths: sourcePaths,
      llm_file_paths: llmPaths
    },
    maxImages: 8,
    detail: "low"
  });
  assert.equal(imageInputs.length, 2);
  assert.deepEqual(imageInputs.map((item) => item.metadata.file_path), llmPaths.map((item) => path.resolve(item)));
  assert.equal(imageInputs.every((item) => item.image_url.detail === "low"), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCallScreeningLlmDefaultsThinkingLow() {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: { content: "{\"passed\": true}" },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 12 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "thinking-default",
        text: "张三\n算法工程师\n本科"
      }),
      criteria: "算法经验",
      config: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "test-key",
        model: "doubao-seed-2.0-lite"
      },
      timeoutMs: 1000
    });
    assert.equal(result.passed, true);
    assert.deepEqual(payload.thinking, { type: "enabled" });
    assert.equal(payload.max_tokens, 512);
    assert.equal(result.provider.thinking_level, "low");
    assert.deepEqual(result.provider.thinking, { type: "enabled" });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmSendsReasoningEffortForOpenAiCompatibleDoubao() {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: "{\"passed\": true}",
                reasoning_content: "proxy nested reasoning",
                role: "assistant",
                provider_specific_fields: {
                  reasoning_content: "proxy nested reasoning"
                }
              },
              reasoning_content: "proxy nested reasoning",
              finish_reason: "stop"
            }
          ],
          usage: {
            total_tokens: 16,
            completion_tokens_details: {
              reasoning_tokens: 8
            }
          }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "doubao-openai-proxy",
        text: "张三\n算法工程师\n本科"
      }),
      criteria: "算法经验",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "doubao-seed-2.0-code"
      },
      timeoutMs: 1000
    });
    assert.equal(result.passed, true);
    assert.deepEqual(payload.thinking, { type: "enabled" });
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(result.reasoning_content, "proxy nested reasoning");
    assert.equal(result.cot, "proxy nested reasoning");
    assert.equal(result.provider.reasoning_effort, "low");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmCollapsesRepeatedReasoningBlock() {
  const originalFetch = globalThis.fetch;
  const repeatedReasoning = [
    "用户希望我严格判断候选人是否满足筛选标准。",
    "",
    "标准1满足，因为本科院校符合要求。",
    "标准2满足，因为至少一段学历符合要求。",
    "标准3满足，因为有计算机视觉算法科研经验。",
    "标准4满足，因为最高学历毕业年份是2027。"
  ].join("\n");
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"passed\": true}",
              reasoning_content: `${repeatedReasoning}\n\n${repeatedReasoning}`
            },
            finish_reason: "stop"
          }
        ],
        usage: { total_tokens: 20 }
      });
    }
  });
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "dedupe-reasoning",
        text: "张三\n视觉算法\n本科"
      }),
      criteria: "算法经验",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5"
      },
      timeoutMs: 1000
    });
    assert.equal(result.passed, true);
    assert.equal(result.reasoning_content, repeatedReasoning);
    assert.equal(result.cot, repeatedReasoning);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmUsesConfigThinkingAndBudget() {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: "{\"passed\": false}",
                reasoning_content: "configured reasoning"
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 20 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "chat",
        source: "fixture",
        id: "thinking-configured",
        text: "李四\n视觉算法\n硕士"
      }),
      criteria: "算法经验",
      config: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        apiKey: "test-key",
        model: "doubao-seed-2.0-lite",
        llmThinkingLevel: "off",
        llmMaxTokens: 128,
        llmMaxCompletionTokens: 256,
        temperature: 0,
        topP: 0.2
      },
      timeoutMs: 1000
    });
    assert.equal(result.passed, false);
    assert.deepEqual(payload.thinking, { type: "disabled" });
    assert.equal(payload.max_tokens, 256);
    assert.equal(payload.max_completion_tokens, 256);
    assert.equal(payload.temperature, 0);
    assert.equal(payload.top_p, 0.2);
    assert.equal(result.provider.thinking_level, "off");
    assert.deepEqual(result.provider.thinking, { type: "disabled" });
    assert.equal(result.provider.max_tokens, 256);
    assert.equal(result.provider.max_completion_tokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmCurrentRequiresSummaryForCot() {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  passed: false,
                  summary: "passed=false；学历证据不足，算法经验与毕业年份仍需核验。"
                })
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 30 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "current-summary",
        text: "候选人\n本科\n算法经验"
      }),
      criteria: "必须本科且有算法经验",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmThinkingLevel: "current"
      },
      timeoutMs: 1000
    });
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.messages[0].content.includes("summary"), true);
    assert.equal(payload.messages[1].content.includes("\"summary\""), true);
    assertPromptHasFailFast(payload.messages);
    assert.equal(result.passed, false);
    assert.equal(result.cot, "passed=false；学历证据不足，算法经验与毕业年份仍需核验。");
    assert.equal(result.reasoning_content, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testCompactScreeningLlmResultPreservesCurrentSummaryCot() {
  const summary = "passed=false；当前经历命中硬性淘汰项，已停止后续评估。";
  const result = {
    ok: true,
    provider: {
      model: "kimi-k2.5",
      thinking_level: "current"
    },
    passed: false,
    cot: summary,
    decision_cot: summary,
    reasoning_content: "",
    raw_model_output: JSON.stringify({ passed: false, summary }),
    evidence: [],
    usage: { total_tokens: 31 },
    finish_reason: "stop",
    image_input_count: 3,
    attempt_count: 1,
    fallback_count: 0,
    screening_strategy: "fast_first_verified",
    fast_thinking_level: "current",
    verify_thinking_level: "low",
    verified: false,
    verification_reason: "",
    decision_source: "fast",
    fast_result: {
      ok: true,
      passed: false,
      cot: summary,
      provider: {
        model: "kimi-k2.5",
        thinking_level: "current"
      }
    },
    verify_result: null
  };
  const compact = compactScreeningLlmResult(result);
  assert.equal(compact.provider.thinking_level, "current");
  assert.equal(compact.passed, false);
  assert.equal(compact.cot, summary);
  assert.equal(compact.reasoning_content, "");
  assert.equal(compact.raw_model_output.includes("summary"), true);
  assert.equal(compact.screening_strategy, "fast_first_verified");
  assert.equal(compact.fast_thinking_level, "current");
  assert.equal(compact.verify_thinking_level, "low");
  assert.equal(compact.verified, false);
  assert.equal(compact.decision_source, "fast");
  assert.equal(compact.fast_result.passed, false);

  const chatShapedCompact = {
    ok: Boolean(result.ok),
    provider: result.provider || null,
    passed: result.passed,
    review_required: typeof result.review_required === "boolean" ? result.review_required : null,
    cot: result.cot || result.decision_cot || "",
    reasoning_content: result.reasoning_content || "",
    raw_model_output: result.raw_model_output || "",
    screening_strategy: result.screening_strategy || "",
    fast_thinking_level: result.fast_thinking_level || "",
    verify_thinking_level: result.verify_thinking_level || "",
    verified: typeof result.verified === "boolean" ? result.verified : null,
    verification_reason: result.verification_reason || "",
    decision_source: result.decision_source || "",
    fast_result: result.fast_result || null,
    verify_result: result.verify_result || null
  };
  assert.equal(chatShapedCompact.provider.thinking_level, "current");
  assert.equal(chatShapedCompact.cot, summary);
  assert.equal(chatShapedCompact.screening_strategy, "fast_first_verified");
  assert.equal(chatShapedCompact.decision_source, "fast");
}

async function testCallScreeningLlmCurrentRejectsMissingSummary() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [
          {
            message: { content: "{\"passed\": true}" },
            finish_reason: "stop"
          }
        ],
        usage: { total_tokens: 20 }
      });
    }
  });
  try {
    await assert.rejects(
      () => callScreeningLlm({
        candidate: normalizeCandidateProfile({
          domain: "recommend",
          source: "fixture",
          id: "current-missing-summary",
          text: "候选人\n本科\n算法经验"
        }),
        criteria: "必须本科",
        config: {
          baseUrl: "https://coding.example.com/v1",
          apiKey: "test-key",
          model: "kimi-k2.5",
          llmThinkingLevel: "current",
          llmMaxRetries: 0
        },
        timeoutMs: 1000
      }),
      /missing brief summary/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmNonCurrentStaysBooleanOnlyAndCapturesProviderCot() {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: "{\"passed\": true}",
                reasoning_content: "provider cot"
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 24 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "low-cot",
        text: "候选人\n本科\n算法经验"
      }),
      criteria: "必须本科",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmThinkingLevel: "low"
      },
      timeoutMs: 1000
    });
    assert.equal(payload.messages[0].content.includes("summary"), false);
    assert.equal(payload.messages[1].content.includes("\"summary\""), false);
    assertPromptHasFailFast(payload.messages);
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(result.passed, true);
    assert.equal(result.cot, "provider cot");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastFirstClearFailSkipsVerify() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  passed: false,
                  summary: "passed=false；硬性条件明确不满足，无需复核。",
                  review_required: false
                })
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 22 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-clear-fail",
        text: "候选人\n不满足硬性条件"
      }),
      criteria: "必须满足硬性条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmThinkingLevel: "high",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoning_effort, undefined);
    assert.equal(calls[0].max_tokens, 384);
    assert.equal(calls[0].messages[1].content.includes("\"review_required\""), true);
    assertPromptHasFastReviewCounterevidenceGuard(calls[0].messages);
    assert.equal(result.passed, false);
    assert.equal(result.cot, "passed=false；硬性条件明确不满足，无需复核。");
    assert.equal(result.review_required, false);
    assert.equal(result.screening_strategy, "fast_first_verified");
    assert.equal(result.fast_thinking_level, "current");
    assert.equal(result.verify_thinking_level, "low");
    assert.equal(result.verified, false);
    assert.equal(result.decision_source, "fast");
    assert.equal(result.verification_reason, "");
    assert.equal(result.provider.thinking_level, "current");
    assert.equal(result.fast_result.passed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastPassVerifiesAndVerifierWins() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    const isFast = calls.length === 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            isFast
              ? {
                message: {
                  content: JSON.stringify({
                    passed: true,
                    summary: "passed=true；快速轮认为满足但需要复核通过项。",
                    review_required: false
                  })
                },
                finish_reason: "stop"
              }
              : {
                message: {
                  content: "{\"passed\": false}",
                  reasoning_content: "verifier cot"
                },
                finish_reason: "stop"
              }
          ],
          usage: { total_tokens: isFast ? 20 : 40 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-pass-verify",
        text: "候选人\n边界案例"
      }),
      criteria: "必须满足全部条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxTokens: 2048,
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].reasoning_effort, undefined);
    assert.equal(calls[1].reasoning_effort, "low");
    assert.equal(calls[0].max_tokens, 384);
    assert.equal(calls[1].max_tokens, 2048);
    assert.equal(result.passed, false);
    assert.equal(result.cot, "verifier cot");
    assert.equal(result.verified, true);
    assert.equal(result.decision_source, "verify");
    assert.equal(result.verification_reason, "fast_passed");
    assert.equal(result.fast_result.passed, true);
    assert.equal(result.verify_result.passed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastFirstUsesPassSpecificTokenCaps() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    const isFast = calls.length === 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            isFast
              ? {
                message: {
                  content: JSON.stringify({
                    passed: true,
                    summary: "passed=true；快速轮通过后复核。",
                    review_required: false
                  })
                },
                finish_reason: "stop"
              }
              : {
                message: {
                  content: "{\"passed\": true}",
                  reasoning_content: "verifier cot"
                },
                finish_reason: "stop"
              }
          ],
          usage: { total_tokens: isFast ? 20 : 40 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-pass-token-caps",
        text: "候选人\n证据完整"
      }),
      criteria: "必须满足全部条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxTokens: 2048,
        llmMaxCompletionTokens: 4096,
        llmFastMaxTokens: 256,
        llmVerifyMaxTokens: 768,
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].max_tokens, 256);
    assert.equal(calls[0].max_completion_tokens, undefined);
    assert.equal(calls[1].max_tokens, 768);
    assert.equal(calls[1].max_completion_tokens, undefined);
    assert.equal(result.provider.max_tokens, 768);
    assert.equal(result.fast_result.provider.max_tokens, 256);
    assert.equal(result.verify_result.provider.max_tokens, 768);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastUncertainFailVerifies() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    const isFast = calls.length === 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            isFast
              ? {
                message: {
                  content: JSON.stringify({
                    passed: false,
                    summary: "passed=false；证据边界不清，需要复核。",
                    review_required: true
                  })
                },
                finish_reason: "stop"
              }
              : {
                message: {
                  content: "{\"passed\": true}",
                  reasoning_content: "medium verifier cot"
                },
                finish_reason: "stop"
              }
          ],
          usage: { total_tokens: isFast ? 25 : 42 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "chat",
        source: "fixture",
        id: "fast-uncertain-fail",
        text: "候选人\n证据边界案例"
      }),
      criteria: "证据不足则不通过，但截图可能有补充信息",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "minimal",
        llmVerifyThinkingLevel: "medium",
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].reasoning_effort, "minimal");
    assert.equal(calls[1].reasoning_effort, "medium");
    assert.equal(result.passed, true);
    assert.equal(result.cot, "medium verifier cot");
    assert.equal(result.verification_reason, "fast_review_required");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastInvalidOutputRetries() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: calls === 1
                  ? "{}"
                  : JSON.stringify({
                    passed: false,
                    summary: "passed=false；重试后得到明确淘汰结论。",
                    review_required: false
                  })
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 18 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-invalid-retry",
        text: "候选人\n明确不通过"
      }),
      criteria: "必须满足硬性条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxRetries: 1
      },
      timeoutMs: 1000
    });
    assert.equal(calls, 2);
    assert.equal(result.passed, false);
    assert.equal(result.verified, false);
    assert.equal(result.attempt_count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastFirstAllInvalidFailsClosed() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: { content: "{}" },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 10 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-all-invalid",
        text: "候选人\n无法判断"
      }),
      criteria: "必须满足硬性条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.passed, false);
    assert.equal(result.verified, true);
    assert.equal(result.decision_source, "verify_error");
    assert.equal(result.verification_reason, "fast_invalid_response");
    assert.equal(result.error.includes("missing boolean passed decision"), true);
    assert.equal(result.fast_result.ok, false);
    assert.equal(result.verify_result.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmVerifierCurrentSummaryIsPreserved() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    const isFast = calls.length === 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(isFast
                  ? {
                    passed: true,
                    summary: "passed=true；快速轮通过，进入 current 复核。",
                    review_required: false
                  }
                  : {
                    passed: true,
                    summary: "passed=true；复核确认核心证据完整。"
                  })
              },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: isFast ? 22 : 28 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recruit",
        source: "fixture",
        id: "verify-current-summary",
        text: "候选人\n证据完整"
      }),
      criteria: "必须满足全部条件",
      config: {
        baseUrl: "https://coding.example.com/v1",
        apiKey: "test-key",
        model: "kimi-k2.5",
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "current",
        llmMaxRetries: 0
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].reasoning_effort, undefined);
    assert.equal(result.passed, true);
    assert.equal(result.cot, "passed=true；复核确认核心证据完整。");
    assert.equal(result.verify_result.cot, "passed=true；复核确认核心证据完整。");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastFirstSupportsConfiguredLevelPairs() {
  const originalFetch = globalThis.fetch;
  const pairs = [
    ["minimal", "low"],
    ["current", "medium"],
    ["off", "low"]
  ];
  try {
    for (const [fastLevel, verifyLevel] of pairs) {
      const calls = [];
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        calls.push(payload);
        const isFast = calls.length === 1;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [
                isFast
                  ? {
                    message: {
                      content: JSON.stringify({
                        passed: true,
                        summary: "passed=true；快速轮通过后复核。",
                        review_required: false
                      })
                    },
                    finish_reason: "stop"
                  }
                  : {
                    message: {
                      content: "{\"passed\": true}",
                      reasoning_content: `${verifyLevel} verifier cot`
                    },
                    finish_reason: "stop"
                  }
              ],
              usage: { total_tokens: 20 }
            });
          }
        };
      };
      const result = await callScreeningLlm({
        candidate: normalizeCandidateProfile({
          domain: "recommend",
          source: "fixture",
          id: `level-${fastLevel}-${verifyLevel}`,
          text: "候选人\n证据完整"
        }),
        criteria: "必须满足全部条件",
        config: {
          baseUrl: "https://coding.example.com/v1",
          apiKey: "test-key",
          model: "kimi-k2.5",
          llmScreeningStrategy: "fast_first_verified",
          llmFastThinkingLevel: fastLevel,
          llmVerifyThinkingLevel: verifyLevel,
          llmMaxRetries: 0
        },
        timeoutMs: 1000
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].reasoning_effort, fastLevel === "current" ? undefined : (fastLevel === "off" ? "minimal" : fastLevel));
      assert.equal(calls[1].reasoning_effort, verifyLevel === "current" ? undefined : (verifyLevel === "off" ? "minimal" : verifyLevel));
      assert.equal(result.fast_thinking_level, fastLevel);
      assert.equal(result.verify_thinking_level, verifyLevel);
      assert.equal(result.verified, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmRetriesTransientFailure() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("fetch failed");
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: { content: "{\"passed\": false}" },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 12 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "retry-default",
        text: "张三\n算法工程师\n本科"
      }),
      criteria: "算法经验",
      config: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "test-key",
        model: "doubao-seed-2.0-lite",
        llmMaxRetries: 1
      },
      timeoutMs: 1000
    });
    assert.equal(calls, 2);
    assert.equal(result.passed, false);
    assert.equal(result.attempt_count, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFallsBackToNextConfiguredModel() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url: String(url), payload });
    if (payload.model === "primary-model") {
      return {
        ok: false,
        status: 500,
        async text() {
          return "primary temporarily unavailable";
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: { content: "{\"passed\": true}" },
              finish_reason: "stop"
            }
          ],
          usage: { total_tokens: 10 }
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fallback-configured",
        text: "王五\n算法工程师\n硕士"
      }),
      criteria: "算法经验",
      config: {
        llmMaxRetries: 0,
        llmModels: [
          {
            name: "primary",
            baseUrl: "https://primary.example.com/v1",
            apiKey: "primary-key",
            model: "primary-model"
          },
          {
            name: "backup",
            baseUrl: "https://backup.example.com/v1",
            apiKey: "backup-key",
            model: "backup-model"
          }
        ]
      },
      timeoutMs: 1000
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://primary.example.com/v1/chat/completions");
    assert.equal(calls[1].url, "https://backup.example.com/v1/chat/completions");
    assert.equal(result.passed, true);
    assert.equal(result.provider.name, "backup");
    assert.equal(result.provider.model, "backup-model");
    assert.equal(result.attempt_count, 2);
    assert.equal(result.fallback_count, 1);
    assert.equal(result.llm_model_failures.length, 1);
    assert.equal(result.llm_model_failures[0].model, "primary-model");
    assert.equal(result.llm_model_failures[0].baseUrl, "https://[redacted-host]/v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFatalProviderFallsBackAndKeepsCircuitOpen() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const config = {
    llmMaxRetries: 0,
    llmModels: [
      {
        name: "denied-primary",
        baseUrl: "https://denied.example.com/v1",
        apiKey: "denied-key",
        model: "denied-model"
      },
      {
        name: "healthy-backup",
        baseUrl: "https://healthy.example.com/v1",
        apiKey: "healthy-key",
        model: "healthy-model"
      }
    ]
  };
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url: String(url), model: payload.model });
    if (payload.model === "denied-model") {
      return {
        ok: false,
        status: 403,
        async text() {
          return JSON.stringify({
            error: {
              message: "model access denied",
              type: "permission_denied",
              code: "forbidden"
            }
          });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: { content: "{\"passed\": true}" },
              finish_reason: "stop"
            }
          ]
        });
      }
    };
  };
  const candidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "fixture",
    id: "fatal-provider-fallback",
    text: "赵六\n算法工程师\n博士"
  });
  try {
    const first = await callScreeningLlm({
      candidate,
      criteria: "算法经验",
      config,
      timeoutMs: 1000
    });
    assert.deepEqual(calls.map((item) => item.model), ["denied-model", "healthy-model"]);
    assert.equal(first.provider.name, "healthy-backup");
    assert.equal(first.fallback_count, 1);
    assert.equal(first.attempt_count, 2);
    assert.equal(first.llm_model_failures.length, 1);
    assert.equal(first.llm_model_failures[0].fatal, true);
    assert.equal(first.llm_model_failures[0].fatal_code, "LLM_PERMISSION_DENIED");
    assert.equal(first.llm_model_failures[0].circuit_open, true);
    assert.equal(first.llm_model_failures[0].circuit_skipped, false);

    const second = await callScreeningLlm({
      candidate,
      criteria: "算法经验",
      config,
      timeoutMs: 1000
    });
    assert.deepEqual(calls.map((item) => item.model), ["denied-model", "healthy-model", "healthy-model"]);
    assert.equal(second.provider.name, "healthy-backup");
    assert.equal(second.fallback_count, 1);
    assert.equal(second.attempt_count, 1);
    assert.equal(second.llm_model_failures[0].fatal_code, "LLM_PERMISSION_DENIED");
    assert.equal(second.llm_model_failures[0].attempts, 0);
    assert.equal(second.llm_model_failures[0].circuit_open, true);
    assert.equal(second.llm_model_failures[0].circuit_skipped, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmFastFirstReusesFatalProviderCircuitForVerify() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload.model);
    if (payload.model === "quota-model") {
      return {
        ok: false,
        status: 429,
        async text() {
          return JSON.stringify({
            error: {
              message: "insufficient quota",
              type: "insufficient_quota",
              code: "insufficient_quota"
            }
          });
        }
      };
    }
    const isFastPass = calls.filter((model) => model === "backup-model").length === 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: isFastPass
                  ? "{\"passed\": true, \"summary\": \"初筛通过\", \"review_required\": true}"
                  : "{\"passed\": true}"
              },
              finish_reason: "stop"
            }
          ]
        });
      }
    };
  };
  try {
    const result = await callScreeningLlm({
      candidate: normalizeCandidateProfile({
        domain: "recommend",
        source: "fixture",
        id: "fast-first-fatal-fallback",
        text: "候选人\n视觉算法工程师\n博士"
      }),
      criteria: "视觉算法经验",
      config: {
        llmScreeningStrategy: "fast_first_verified",
        llmFastThinkingLevel: "current",
        llmVerifyThinkingLevel: "low",
        llmMaxRetries: 0,
        llmModels: [
          {
            name: "quota-primary",
            baseUrl: "https://quota.example.com/v1",
            apiKey: "quota-key",
            model: "quota-model"
          },
          {
            name: "backup",
            baseUrl: "https://backup.example.com/v1",
            apiKey: "backup-key",
            model: "backup-model"
          }
        ]
      },
      timeoutMs: 1000
    });
    assert.deepEqual(calls, ["quota-model", "backup-model", "backup-model"]);
    assert.equal(result.passed, true);
    assert.equal(result.verified, true);
    assert.equal(result.provider.name, "backup");
    assert.equal(result.llm_model_failures[0].fatal_code, "LLM_QUOTA_EXCEEDED");
    assert.equal(result.llm_model_failures[0].circuit_skipped, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCallScreeningLlmThrowsFatalOnlyAfterAllProvidersUnavailable() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const config = {
    llmMaxRetries: 0,
    llmModels: [
      {
        name: "auth-primary",
        baseUrl: "https://auth.example.com/v1",
        apiKey: "invalid-key",
        model: "auth-model"
      },
      {
        name: "billing-backup",
        baseUrl: "https://billing.example.com/v1",
        apiKey: "billing-key",
        model: "billing-model"
      }
    ]
  };
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    const authFailure = payload.model === "auth-model";
    return {
      ok: false,
      status: authFailure ? 401 : 402,
      async text() {
        return JSON.stringify({
          error: authFailure
            ? { message: "invalid api key", type: "authentication_error", code: "invalid_api_key" }
            : { message: "insufficient balance; payment required", type: "billing_error", code: "billing_required" }
        });
      }
    };
  };
  const candidate = normalizeCandidateProfile({
    domain: "recommend",
    source: "fixture",
    id: "all-fatal-providers",
    text: "候选人\n算法工程师"
  });
  try {
    await assert.rejects(
      () => callScreeningLlm({ candidate, criteria: "算法经验", config, timeoutMs: 1000 }),
      (error) => {
        assert.equal(isFatalLlmProviderError(error), true);
        assert.equal(error.code, "LLM_ALL_PROVIDERS_UNAVAILABLE");
        assert.equal(error.llm_fatal_reason, "all_providers_unavailable");
        assert.equal(error.llm_attempt_count, 2);
        assert.equal(error.llm_provider_failures.length, 2);
        assert.deepEqual(error.llm_fatal_provider_codes, ["LLM_AUTH_FAILED", "LLM_BILLING_REQUIRED"]);
        assert.equal(error.llm_provider_failures.every((item) => item.circuit_open), true);
        assert.equal(error.llm_provider_failures.every((item) => !item.circuit_skipped), true);
        const wrapped = createFatalLlmRunError(error, { domain: "recommend", candidate });
        assert.equal(wrapped.code, "LLM_ALL_PROVIDERS_UNAVAILABLE");
        assert.equal(wrapped.llm_provider_failures.length, 2);
        assert.deepEqual(wrapped.llm_fatal_provider_codes, ["LLM_AUTH_FAILED", "LLM_BILLING_REQUIRED"]);
        return true;
      }
    );
    assert.equal(calls, 2);

    await assert.rejects(
      () => callScreeningLlm({ candidate, criteria: "算法经验", config, timeoutMs: 1000 }),
      (error) => {
        assert.equal(isFatalLlmProviderError(error), true);
        assert.equal(error.code, "LLM_ALL_PROVIDERS_UNAVAILABLE");
        assert.equal(error.llm_attempt_count, 0);
        assert.equal(error.llm_provider_failures.every((item) => item.circuit_skipped), true);
        return true;
      }
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testFatalLlmProviderErrorClassification() {
  const budget = new Error("LLM request failed: 400 {\"error\":{\"message\":\"Budget has been exceeded! Current cost: 100.1, Max budget: 100.0\",\"type\":\"budget_exceeded\",\"code\":\"400\"}}");
  budget.status = 400;
  assert.deepEqual(classifyFatalLlmProviderError(budget), {
    code: "LLM_BUDGET_EXCEEDED",
    reason: "budget_exceeded"
  });
  const auth = new Error("LLM request failed: 401 unauthorized");
  auth.status = 401;
  assert.deepEqual(classifyFatalLlmProviderError(auth), {
    code: "LLM_AUTH_FAILED",
    reason: "auth_failed"
  });
  const permission = new Error("LLM request failed: 403 forbidden");
  permission.status = 403;
  assert.deepEqual(classifyFatalLlmProviderError(permission), {
    code: "LLM_PERMISSION_DENIED",
    reason: "permission_denied"
  });
  const quota = new Error("LLM request failed: insufficient_quota");
  quota.provider_error_code = "insufficient_quota";
  assert.deepEqual(classifyFatalLlmProviderError(quota), {
    code: "LLM_QUOTA_EXCEEDED",
    reason: "quota_exceeded"
  });
  const billing = new Error("LLM request failed: insufficient balance; payment required");
  assert.deepEqual(classifyFatalLlmProviderError(billing), {
    code: "LLM_BILLING_REQUIRED",
    reason: "billing_required"
  });
  const invalidJson = new Error("LLM response was not valid JSON");
  assert.equal(classifyFatalLlmProviderError(invalidJson), null);
  const fatal = createFatalLlmRunError(budget, {
    domain: "recommend",
    candidate: { id: "candidate-1", identity: { name: "候选人" } }
  });
  assert.equal(isFatalLlmProviderError(fatal), true);
  assert.equal(fatal.code, "LLM_BUDGET_EXCEEDED");
  assert.equal(fatal.domain, "recommend");
  assert.equal(fatal.candidate_id, "candidate-1");
}

async function testCallScreeningLlmFatalProviderErrorRetriesTwiceThenThrows() {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({
          error: {
            message: "Budget has been exceeded! Current cost: 100.0004, Max budget: 100.0",
            type: "budget_exceeded",
            code: "400"
          }
        });
      }
    };
  };
  try {
    await assert.rejects(
      () => callScreeningLlm({
        candidate: normalizeCandidateProfile({
          domain: "recommend",
          source: "fixture",
          id: "fatal-budget",
          text: "候选人\n增长负责人"
        }),
        criteria: "必须满足硬性条件",
        config: {
          baseUrl: "https://coding.example.com/v1",
          apiKey: "test-key",
          model: "kimi-k2.5",
          llmScreeningStrategy: "fast_first_verified",
          llmFastThinkingLevel: "current",
          llmVerifyThinkingLevel: "low",
          llmMaxRetries: 0
        },
        timeoutMs: 1000
      }),
      (error) => {
        assert.equal(isFatalLlmProviderError(error), true);
        assert.equal(error.code, "LLM_BUDGET_EXCEEDED");
        assert.equal(error.llm_attempt_count, 3);
        return true;
      }
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

testHtmlToText();
testNormalizeFromHtml();
testNormalizeFromHtmlSkipsSalaryAsName();
testNormalizeProfile();
testScreenCandidate();
testBossNetworkProfileExtraction();
testBossNetworkProfileExtractionFromGeekDetail();
testBossNetworkProfileExtractionFromNestedData();
testBossNetworkProfileExtractionFromHtmlEmbeddedJson();
testBossNetworkEncryptedResumeExplainsImageFallback();
testBossChatGeekInfoExtraction();
testBossChatHistoryResumeExtraction();
testBuildScreeningCandidateFromDetailUsesCleanNetworkText();
testRecommendNetworkProfileRequiresExactCardIdAndName();
testRecommendNetworkProfileMismatchIsFullyExcludedForImageFallback();
testRecommendNetworkProfileRejectsWrongNameAndGenericUid();
testRecommendMixedNetworkBatchUsesOnlyExactBoundProfile();
testNonRecommendNetworkProfileCompatibilityIsPreserved();
testBuildScreeningLlmMessages();
testBuildScreeningLlmMessagesFailFastForAllThinkingModes();
testBuildScreeningLlmMessagesFastFirstRequiresReviewOnCounterevidence();
testBuildScreeningLlmMessagesWithImages();
testBuildScreeningLlmImageInputsPrefersComposedFullCvImages();
await testCallScreeningLlmDefaultsThinkingLow();
await testCallScreeningLlmSendsReasoningEffortForOpenAiCompatibleDoubao();
await testCallScreeningLlmCollapsesRepeatedReasoningBlock();
await testCallScreeningLlmUsesConfigThinkingAndBudget();
await testCallScreeningLlmCurrentRequiresSummaryForCot();
testCompactScreeningLlmResultPreservesCurrentSummaryCot();
await testCallScreeningLlmCurrentRejectsMissingSummary();
await testCallScreeningLlmNonCurrentStaysBooleanOnlyAndCapturesProviderCot();
await testCallScreeningLlmFastFirstClearFailSkipsVerify();
await testCallScreeningLlmFastPassVerifiesAndVerifierWins();
await testCallScreeningLlmFastFirstUsesPassSpecificTokenCaps();
await testCallScreeningLlmFastUncertainFailVerifies();
await testCallScreeningLlmFastInvalidOutputRetries();
await testCallScreeningLlmFastFirstAllInvalidFailsClosed();
await testCallScreeningLlmVerifierCurrentSummaryIsPreserved();
await testCallScreeningLlmFastFirstSupportsConfiguredLevelPairs();
await testCallScreeningLlmRetriesTransientFailure();
await testCallScreeningLlmFallsBackToNextConfiguredModel();
await testCallScreeningLlmFatalProviderFallsBackAndKeepsCircuitOpen();
await testCallScreeningLlmFastFirstReusesFatalProviderCircuitForVerify();
await testCallScreeningLlmThrowsFatalOnlyAfterAllProvidersUnavailable();
testFatalLlmProviderErrorClassification();
await testCallScreeningLlmFatalProviderErrorRetriesTwiceThenThrows();

console.log("Core screening tests passed");
