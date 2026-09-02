export { escapeHtml, safeUrl } from "./src/html.js"
export { sendGmailMessage } from "./src/gmail.js"
export { renderDigestContent, validateDigestContent } from "./src/digest.js"
export {
  readJsonArray,
  writeJsonArray,
  deleteIfExists,
  makeKeyFn,
  normalizeField,
} from "./src/seenStore.js"
export { createCheckDedupTool, createAppendSeenTool } from "./src/dedupTools.js"
export {
  createRenderDigestTool,
  createValidateDigestTool,
  createSendDigestEmailTool,
} from "./src/digestTools.js"
export { createFilterFutureEventsTool } from "./src/filterFutureEvents.js"
export { buildCalibrationBlock, readCalibrationBlock } from "./src/calibration.js"
export { createCalibrationTool } from "./src/calibrationTool.js"
export { buildScorecard, appendRun } from "./src/scorecard.js"
// Only the digest-side half of oneClickMark is re-exported here. The route
// half (createOneClickMarkRoute) belongs to the interest-servers, which
// import "radar-kit/oneClickMark" directly so they never evaluate this file
// -- same split as calibration.js vs calibrationTool.js.
export { markUrls } from "./src/oneClickMark.js"
export { createValidateGmailSendPlugin } from "./src/validateGmailSendPlugin.js"
