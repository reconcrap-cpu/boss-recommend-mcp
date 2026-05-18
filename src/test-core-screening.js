import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  buildScreeningLlmImageInputs,
  buildScreeningCandidateFromDetail,
  buildScreeningLlmMessages,
  callScreeningLlm,
  extractBossProfileFromNetworkBody,
  htmlToText,
  normalizeCandidateFromHtml,
  normalizeCandidateProfile,
  screenCandidate
} from "./core/screening/index.js";

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
  assert.equal(messages[1].content[1].type, "image_url");
  assert.equal(messages[1].content[1].image_url.url.startsWith("data:image/png;base64,"), true);
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
testBuildScreeningLlmMessages();
testBuildScreeningLlmMessagesWithImages();
testBuildScreeningLlmImageInputsPrefersComposedFullCvImages();
await testCallScreeningLlmDefaultsThinkingLow();
await testCallScreeningLlmSendsReasoningEffortForOpenAiCompatibleDoubao();
await testCallScreeningLlmCollapsesRepeatedReasoningBlock();
await testCallScreeningLlmUsesConfigThinkingAndBudget();
await testCallScreeningLlmRetriesTransientFailure();
await testCallScreeningLlmFallsBackToNextConfiguredModel();

console.log("Core screening tests passed");
