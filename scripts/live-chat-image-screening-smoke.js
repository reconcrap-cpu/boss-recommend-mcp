#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  callScreeningLlm,
  normalizeCandidateProfile
} from "../src/core/screening/index.js";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    sourcePayload: ".live-artifacts/chat-full-cv-image-fallback-live.json",
    saveReport: ".live-artifacts/chat-full-cv-image-llm-screening-live.json",
    configPath: path.join(process.env.USERPROFILE || "C:\\Users\\yaolin", ".boss-recommend-mcp", "screening-config.json"),
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    maxImages: 8,
    imageDetail: "high",
    timeoutMs: 120000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-payload") result.sourcePayload = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--config") result.configPath = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--max-images") result.maxImages = parsePositiveInt(argv[++index], result.maxImages);
    if (arg === "--image-detail") result.imageDetail = argv[++index];
    if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
  }
  return result;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function summarizeLlmResult(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    provider: result.provider,
    passed: result.passed,
    reason: result.reason,
    evidence: result.evidence,
    usage: result.usage,
    finish_reason: result.finish_reason,
    raw_content_length: result.raw_content_length,
    image_input_count: result.image_input_count,
    image_inputs: result.image_inputs,
    screened_at: result.screened_at
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    source_payload: path.resolve(options.sourcePayload),
    config_path: path.resolve(options.configPath),
    criteria: options.criteria
  };
  try {
    const payload = readJsonFile(options.sourcePayload);
    const config = readJsonFile(options.configPath);
    const imageEvidence = payload.resume?.image_evidence || null;
    const imagePaths = Array.isArray(imageEvidence?.file_paths) ? imageEvidence.file_paths : [];
    const existingImagePaths = imagePaths.filter((filePath) => fs.existsSync(path.resolve(filePath)));
    if (!existingImagePaths.length) {
      throw new Error("No saved chat full-CV image pages found in source payload");
    }

    const candidate = normalizeCandidateProfile({
      domain: "chat",
      source: "chat-full-cv-image-live-artifact",
      id: payload.candidate?.id || payload.cards?.selected_card_node_id || "",
      text: payload.candidate?.raw_text_preview || ""
    });
    const llmResult = await callScreeningLlm({
      candidate,
      criteria: options.criteria,
      config,
      timeoutMs: Number(config.llmTimeoutMs || options.timeoutMs),
      imageEvidence: {
        ...imageEvidence,
        file_paths: existingImagePaths
      },
      maxImages: options.maxImages,
      imageDetail: options.imageDetail
    });

    report.status = "PASS";
    report.live_artifact = {
      source_status: payload.status,
      generated_at: payload.generated_at,
      detail_source: payload.detail_source,
      image_source: imageEvidence?.source || null,
      screenshot_count: imageEvidence?.screenshot_count || imagePaths.length,
      unique_screenshot_count: imageEvidence?.unique_screenshot_count || null,
      existing_image_count: existingImagePaths.length,
      file_paths: existingImagePaths
    };
    report.candidate = {
      domain: candidate.domain,
      source: candidate.source,
      id: candidate.id,
      text_length: candidate.text.raw.length
    };
    report.llm_result = summarizeLlmResult(llmResult);
  } catch (error) {
    report.status = "FAIL";
    report.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    process.exitCode = 1;
  } finally {
    report.saved_report_path = writeJsonFile(options.saveReport, report);
    console.log(JSON.stringify(report, null, 2));
  }
}

run();
