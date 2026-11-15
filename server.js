const express = require("express");
const EventEmitter = require("events");
const crypto = require("crypto");

const HTTP_PORT = 3000;
const TAB_TIMEOUT_MS = 45000;

const bridgeEvents = new EventEmitter();
let isBusy = false; // Prevents overlapping requests in the browser tab
const requestQueue = [];

function acquireBridgeLock() {
    if (!isBusy) {
        isBusy = true;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        requestQueue.push(resolve);
    });
}

function releaseBridgeLock() {
    const next = requestQueue.shift();
    if (next) {
        next();
    } else {
        isBusy = false;
    }
}
const pendingActions = new Map(); // action id -> { resolve, reject }, filled by the tab's ack/error
let nextActionId = 1;

// ==========================================
// 1. Browser tab transport
// ==========================================
// Gemini's CSP blocks WebSocket to 127.0.0.1, so the tab talks to us through
// GM_xmlhttpRequest (privileged, not subject to page CSP) using long-polling.
let activeTab = null; // { id, href, lastPoll }
let outbox = []; // Commands waiting to be picked up by the tab
const wsLogged = new Set(); // tabIds whose helper-frame status was already logged

// Each action gets a unique id: ack/error responses are correlated by it,
// and the tab de-duplicates redelivered commands.
const tab = () => (activeTab && Date.now() - activeTab.lastPoll < TAB_TIMEOUT_MS ? activeTab : null);

// Why tab() came back empty, for error messages.
function tabStatus() {
    if (!activeTab) return "no tab has ever polled";
    const age = Date.now() - activeTab.lastPoll;
    return `last poll from ${activeTab.href} was ${age}ms ago (limit ${TAB_TIMEOUT_MS}ms)`;
}

function enqueue(command, payload = {}) {
    const id = nextActionId++;
    outbox.push({ behaviour: "gemini_action", command, id, ...payload });
    return id;
}

// Fire-and-forget: the result comes back out of band (stream deltas, completed,
// or an error emitted as `bridge_error`). Used by start_completion/stop_response.
function fireAndForget(command, payload = {}) {
    if (!tab()) throw new Error(`No active Gemini Web Bridge connected (${tabStatus()}).`);
    return enqueue(command, payload);
}

// Action that waits for the tab to confirm it actually did the DOM work.
function performAction(command, payload = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        if (!tab()) {
            reject(new Error(`No active Gemini Web Bridge connected (${tabStatus()}).`));
            return;
        }
        const id = enqueue(command, payload);
        const timer = setTimeout(() => {
            if (pendingActions.delete(id)) reject(new Error(`${command}: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pendingActions.set(id, {
            resolve: () => { clearTimeout(timer); pendingActions.delete(id); resolve(); },
            reject: (err) => { clearTimeout(timer); reject(err); },
        });
    });
}


// Messages sent by the page.
async function handleIncoming(data) {
	console.log(`Received at ${Date.now()}`);
	console.log(data);
    switch (data.behaviour) {
        case "report_existence": {
            const isHelper = data.isTop === false || /gemini\.google\.com\/_\//.test(data.href || "");
            if (isHelper) {
                console.log(`[TAB] Ignoring helper frame: ${data.href}`);
                return;
            }
            if (!activeTab || activeTab.id !== data.tabId) {
                console.log(`[TAB] Gemini tab active at: ${data.href}`);
                activeTab = { id: data.tabId, href: data.href, lastPoll: Date.now() };
            }
            break;
        }

        case "disconnect": {
            if (activeTab && activeTab.id === data.tabId) {
                console.log(`[TAB] Gemini tab disconnected: ${activeTab.href}`);
                activeTab = null;
            }
            if (ghostSession && ghostSession.tabId === data.tabId) {
                ghostSession = null;
            }
            bridgeEvents.emit("bridge_error", {
                command: "stream",
                message: "Gemini browser tab disconnected during execution.",
            });
            break;
        }

        case "ack": {
            const p = pendingActions.get(data.id);
            if (p) p.resolve();
            console.log(`[TAB] <- ack#${data.id}${p ? "" : " (nothing waiting on it)"}`);
            break;
        }

        case "message_stream":
            bridgeEvents.emit("delta", data.delta);
            process.stdout.write(data.delta);
            break;

        case "message_completed":
            console.log("\n[TAB] Response completed.");
            bridgeEvents.emit("completed", data.finalText);
            break;

        case "error": {
            console.error(`[TAB] Bridge Error (${data.command}): ${data.message}`);
            const p = pendingActions.get(data.id);
            if (p) {
                pendingActions.delete(data.id);
                p.reject(new Error(`${data.command}: ${data.message}`));
            } else {
                bridgeEvents.emit("bridge_error", data);
            }
            break;
        }

        default:
            console.log("[TAB] Unhandled message:", data);
    }
}

// ==========================================
// 2. Multi-Protocol Formatting Helpers (OpenAI / Ollama / Claude)
// ==========================================
function extractTextFromContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (part?.type === "text" && typeof part.text === "string") return part.text;
            if (part?.type === "tool_result") {
                return typeof part.content === "string"
                    ? part.content
                    : extractTextFromContent(part.content);
            }
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Calibrated local SentencePiece-style estimator when no API key is configured
function estimateTokens(text = "", imageCount = 0) {
    const str = String(text || "");
    if (!str) return imageCount * 258;
    const cjkChars = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const codePunct = (str.match(/[{}()[\]<>\/\\=+\-*&|^%$#@!~`:;"',.?]/g) || []).length;
    const latinWords = (str.match(/[a-zA-Z0-9_]+/g) || []).reduce(
        (sum, w) => sum + Math.max(1, Math.ceil(w.length / 4)),
        0,
    );
    return Math.ceil(cjkChars * 1.15 + latinWords + codePunct * 0.65) + imageCount * 258;
}

// Use official free Google Gemini countTokens REST API when GEMINI_API_KEY is set
async function countGeminiTokensExact(text = "", fallbackImageCount = 0) {
    if (!GEMINI_API_KEY || !text) {
        return estimateTokens(text, fallbackImageCount);
    }
    try {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens?key=${encodeURIComponent(GEMINI_API_KEY)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: String(text) }] }],
                }),
            },
        );
        if (resp.ok) {
            const data = await resp.json();
            if (typeof data.totalTokens === "number") {
                return data.totalTokens + fallbackImageCount * 258;
            }
        }
    } catch (_) {}
    return estimateTokens(text, fallbackImageCount);
}

async function parseImagePart(part) {
    // OpenAI format: { type: "image_url", image_url: { url: "data:image/png;base64,..." | "https://..." } }
    if (part?.type === "image_url") {
        const rawUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (!rawUrl) return null;
        const dataMatch = rawUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (dataMatch) {
            const mimeType = dataMatch[1];
            const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
            return {
                fileName: `image_${crypto.randomUUID().slice(0, 8)}.${ext}`,
                content: dataMatch[2],
                mimeType,
                isBase64: true,
            };
        }
        if (/^https?:\/\//i.test(rawUrl)) {
            const resp = await fetch(rawUrl);
            const buf = Buffer.from(await resp.arrayBuffer());
            const mimeType = resp.headers.get("content-type")?.split(";")[0] || "image/png";
            const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
            return {
                fileName: `image_${crypto.randomUUID().slice(0, 8)}.${ext}`,
                content: buf.toString("base64"),
                mimeType,
                isBase64: true,
            };
        }
    }
    // Claude / Anthropic format: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
    if (part?.type === "image" && part.source?.type === "base64" && part.source?.data) {
        const mimeType = part.source.media_type || "image/png";
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
        return {
            fileName: `image_${crypto.randomUUID().slice(0, 8)}.${ext}`,
            content: part.source.data,
            mimeType,
            isBase64: true,
        };
    }
    return null;
}

const MAX_SESSION_CHARS = 100000; // Auto-refresh Gemini web chat before hitting 32k limit
const TURN_COOLDOWN_MS = 2500;   // Anti-rate-limit pacing between consecutive web turns
const BRIDGE_SEND_DELAY_MS = parseInt(process.env.BRIDGE_SEND_DELAY_MS || "5000", 10); // Delay before sending prompt to Gemini web (ms), configurable via env

// In-memory Ghost Mode session bound strictly to the live browser tabId
let ghostSession = null;
// Structure:
// {
//   tabId: string | null,        // Bound activeTab.id
//   sentTurnCount: number,       // Number of convoTurns already sent to this Ghost window
//   nonAssistantTurns: string[], // Fingerprint of non-assistant turns sent so far
//   firstUserFingerprint: string,// Normalized fingerprint of the first user message
//   cumulativeChars: number,     // Cumulative chars in this Ghost window
//   needsRefresh: boolean,       // True when cumulativeChars >= MAX_SESSION_CHARS
// }

// Strip dynamic timestamps & harness-injected runtime tags so mid-loop steps stay in the same session
function normalizeTurnFingerprint(text = "") {
    return String(text || "")
        .replace(/<(time-context|runtime-context|system-reminder|skill-catalog)>[\s\S]*?<\/\1>/gi, "")
        .replace(/^Time sampled while preparing turn.*$/gim, "")
        .replace(/^Browser time zone for this request.*$/gim, "")
        .replace(/^Elapsed since the preceding model-visible message.*$/gim, "")
        .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}[^\s\]<]*/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

const CODE_FENCE_RULE =
    "[Formatting Rule]: NEVER use three backticks (```) anywhere in your output because the web UI corrupts backtick blocks. " +
    "Whenever you output a fenced code block or terminal commands, ALWAYS use three middle dots (···) on their own separate lines as both the opening and closing fence (for example:\n···bash\nnpm run dev\n···\n).";

const TOOL_PROTOCOL_RULE =
    "[Function Calling Format & Bridge Permissions]:\n" +
    "CRITICAL: You are connected to a local execution bridge with full access to the local filesystem and tools listed in AVAILABLE FUNCTIONS. NEVER claim that you lack local file tools.\n" +
    "CRITICAL SANDBOX ISOLATION: NEVER use Gemini's built-in Python Code Execution ('Analysing'), built-in web search, or built-in web tools. You MUST execute all commands, file edits, and searches exclusively via 【TOOL_CALL】.\n" +
    "CRITICAL PHASE TIMING RULE: NEVER output 【TOOL_CALL】 during a [[REASON]] thinking turn, and NEVER output [[REASON]] during an Execution Phase turn!\n" +
    "CRITICAL SKILL ISOLATION RULE: Completely IGNORE any built-in web UI skills (such as 'Match My Writing Style', 'wellness_coach', 'business_financial_analyst', or 'retriever:expand_skills'). Those belong to the web interface, NOT this workspace. All real workspace skills are defined in `workspace_spec.txt` (under `<available_skills>` or `skill-catalog`). Whenever a task matches a workspace skill, load it FIRST via 【TOOL_CALL name=\"skill\"】 during the Execution Phase.\n" +
    "1. Note: The attached file `workspace_spec.txt` is already loaded in your conversation context. NEVER call `read` or any file tool on `workspace_spec.txt`.\n" +
    "2. When invoking a function in the Execution Phase, use the EXACT bare function name (NEVER add `default_api:` prefix) and output ONLY 【TOOL_CALL】 blocks:\n" +
    '   【TOOL_CALL name="function_name"】{"arg1": "value1"}【/TOOL_CALL】\n' +
    "3. For multi-line code or file content inside JSON arguments, wrap the raw content directly inside ⟦CONTENT_START⟧ and ⟦CONTENT_END⟧ (do NOT add backticks inside it), and ALWAYS close with ⟦CONTENT_END⟧\"}【/TOOL_CALL】:\n" +
    '   【TOOL_CALL name="write"】{"file_path": "index.html", "content": "⟦CONTENT_START⟧\\n<!DOCTYPE html>...\\n⟦CONTENT_END⟧"}【/TOOL_CALL】\n' +
    '4. COMPLETION SIGNAL: Whenever you finish a normal text answer to the user (without emitting any 【TOOL_CALL】), you MUST append 【END_RESPONSE】 at the very end of your message.';

const INITIAL_THOUGHT_PROMPT =
    "Please enter the deep thinking phase first. Reason through the problem, potential pitfalls, factual accuracy, and edge cases thoroughly inside a [[REASON]]...[[/REASON]] block.\n" +
    "CRITICAL RULES:\n" +
    "1. Inside [[REASON]]...[[/REASON]], write ONLY plain text paragraphs (no #, *, -, `, or code blocks).\n" +
    "2. Do NOT invoke any tools and do NOT output 【TOOL_CALL】 in this turn — tools may ONLY be called after the thinking phase ends in the next Execution Phase turn.\n" +
    "3. STOP generating immediately right after [[/REASON]] — do NOT write any answer or tool call outside the block." +
    "4. Think with the language that the user used. Please do use [[/REASON]] in your reasoning as it breaks the match engine just say close [[REASON]] with /.";

const AUDIT_THOUGHT_PROMPT =
    "Please critically review your reasoning above for any logical flaws, missing edge cases, or factual errors.\n" +
    "- If everything is solid and ready to proceed, reply ONLY with: 【READY】\n" +
    "- If anything needs deeper thought or correction, output ONLY a revised [[REASON]]...[[/REASON]] block in plain text (no Markdown symbols like #, *, -, `, no 【READY】, and STOP immediately after [[/REASON]]).";

function sanitizeThoughtText(text = "") {
    return String(text)
        .replace(/\[\[\/?RE[A-Z]*\]\]/gi, "")
        .replace(/【READY】/g, "")
        .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
        .replace(/^\s*REASON\s*:?\s*/i, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
}

function buildFinalExecutionPrompt(hasTools, toolSignatures = "", workspaceSkillsList = "") {
    if (!hasTools) {
        return (
            "Planning confirmed. Do NOT output [[REASON]] again — the user cannot see [[REASON]] blocks.\n" +
            "Provide your complete, standalone final response now (use ··· on its own line instead of three backticks for code blocks), and append 【END_RESPONSE】 at the very end."
        );
    }
    const skillReminder = workspaceSkillsList
        ? `\nWorkspace skills available (DO NOT use Gemini built-in web skills; load workspace skills via 【TOOL_CALL name="skill"】):\n- ${workspaceSkillsList}\n`
        : "";
    return (
        "Planning confirmed. EXECUTION PHASE IS NOW ACTIVE.\n" +
        "CRITICAL RULES:\n" +
        "1. Do NOT output [[REASON]]...[[/REASON]] in this turn! Thinking is completely finished.\n" +
        "2. Do NOT use Gemini's built-in Python sandbox ('Analysing'); use ONLY the bridge tools below.\n" +
        "3. Use exact bare tool names (NEVER prefix with `default_api:`).\n" +
        `Available tools and exact parameter keys: ${toolSignatures}${skillReminder}\n` +
        "- If any tool action is required, output ONLY the 【TOOL_CALL】 block(s) right now with NO conversational text before or after:\n" +
        '  【TOOL_CALL name="write"】{"file_path": "example.html", "content": "⟦CONTENT_START⟧\n<!DOCTYPE html>...\n⟦CONTENT_END⟧"}【/TOOL_CALL】\n' +
        "- Only if ZERO tool actions are needed and you are giving a final text reply to the user, write your response (using ··· instead of backticks for code) and end with 【END_RESPONSE】." +
        '- The previous rule ONLY means that if YOU DO NOT NEED Any tool, output the final answer. However, if you are prompted that you have no Tool Call Round Leave, DO NOT JUST SAY YOU HAVE COMPLETED, DO NOT OUTPUT END RESPONSE IF YOU STILL NEED TO USE A TOOL, THE NEXT ROUND WILL HELP YOU OUT.'
    );
}

const POST_EXECUTION_AUDIT_PROMPT =
    "CRITICAL AUDIT ALERT: Do NOT output [[REASON]] in this turn!\n" +
    "You have NOT written any file yet, and you have NOT generated any code or executed any tool yet.\n" +
    "Thinking or describing an action inside [[REASON]] does NOT execute it. Zero 【TOOL_CALL】 blocks were emitted in your previous turn.\n" +
    "- If the user's request requires creating/editing files, editing code, searching, or running commands, output ONLY the 【TOOL_CALL name=\"...\"】{...}【/TOOL_CALL】 block(s) right now with NO conversational text and NO [[REASON]] block (use bare function names without `default_api:`).\n" +
    "- Make sure that what the user expect and what you should do, for example, if they expect a working app, you must write a file. Or if you were asked for a complete app, you should not miss out ANY of the functions. If there is any signal that you have not yet done, NEVER OUTPUT END_RESPONSE. Only if the request is a pure Q&A question requiring zero tool execution (and your answer is already complete), reply ONLY with: 【END_RESPONSE】";

function recordSessionChars(chars) {
    if (!ghostSession || !chars) return;
    ghostSession.cumulativeChars = (ghostSession.cumulativeChars || 0) + chars;
    if (ghostSession.cumulativeChars >= MAX_SESSION_CHARS && !ghostSession.needsRefresh) {
        ghostSession.needsRefresh = true;
        console.log(
            `[SESSION] Watermark reached (${ghostSession.cumulativeChars} chars >= ${MAX_SESSION_CHARS}). Next turn will open a fresh Ghost chat.`,
        );
    }
}

// 狀態機版 ··· -> ``` 轉換器：精準區分開啟與關閉圍欄，並自動確保圍欄前後具備獨立換行
function createDotFenceTransformer() {
    let buffer = "";
    let inCodeBlock = false;

    function processBuffer(isFinal = false) {
        let out = "";
        while (buffer.length > 0) {
            const idx = buffer.indexOf("···");
            if (idx === -1) {
                if (isFinal) {
                    out += buffer;
                    buffer = "";
                } else {
                    // 保留尾端最多 2 個 '·'，避免跨 chunk 切斷 '···'
                    const trailing = buffer.match(/·{1,2}$/);
                    const keep = trailing ? trailing[0].length : 0;
                    out += buffer.slice(0, buffer.length - keep);
                    buffer = keep ? buffer.slice(-keep) : "";
                }
                break;
            }

            // 輸出 '···' 之前的內容
            const before = buffer.slice(0, idx);
            out += before;
            buffer = buffer.slice(idx + 3);

            if (!inCodeBlock) {
                // 開啟程式碼區塊：等待讀完語言標籤（直到遇到換行或空白）
                const nlIdx = buffer.indexOf("\n");
                if (nlIdx === -1 && !isFinal) {
                    // 語言標籤還沒收完，把 '···' 放回 buffer 等下一個 chunk
                    buffer = "···" + buffer;
                    break;
                }
                const lineEnd = nlIdx === -1 ? buffer.length : nlIdx;
                const firstLine = buffer.slice(0, lineEnd);
                const langMatch = firstLine.match(/^\s*([a-zA-Z0-9_+#.-]+)\s*(.*)$/);
                let lang = "";
                let restOfFirstLine = "";
                if (langMatch) {
                    lang = langMatch[1];
                    restOfFirstLine = langMatch[2];
                } else {
                    restOfFirstLine = firstLine.trim();
                }

                const needLeadingNewline = out.length > 0 && !out.endsWith("\n");
                out += `${needLeadingNewline ? "\n\n" : ""}\`\`\`${lang}\n`;
                if (restOfFirstLine) {
                    out += `${restOfFirstLine}\n`;
                }
                buffer = nlIdx === -1 ? "" : buffer.slice(nlIdx + 1);
                inCodeBlock = true;
            } else {
                // 關閉程式碼區塊：確保前面有換行、後面有雙換行
                const needLeadingNewline = out.length > 0 && !out.endsWith("\n");
                out += `${needLeadingNewline ? "\n" : ""}\`\`\`\n\n`;
                buffer = buffer.replace(/^\s*\r?\n/, "");
                inCodeBlock = false;
            }
        }
        return out;
    }

    return {
        push(chunk) {
            if (!chunk) return "";
            buffer += chunk;
            return processBuffer(false);
        },
        flush() {
            return processBuffer(true);
        },
    };
}

// Stream-safe stripper for [[REASON]] and [[/REASON]] wrapper tags
function createThoughtTagStripper() {
    const OPEN_RE = /\[\[RE[A-Z]*\]\]/i;
    const CLOSE_RE = /\[\[\/RE[A-Z]*\]\]/i;
    let buffer = "";
    let state = "before_open"; // "before_open" | "inside" | "after_close"

    return {
        push(chunk) {
            if (!chunk || state === "after_close") return "";
            buffer += chunk;

            if (state === "before_open") {
                const match = buffer.match(OPEN_RE);
                if (match) {
                    state = "inside";
                    buffer = buffer.slice(match.index + match[0].length);
                } else if (buffer.length > 14) {
                    // Fallback if model omitted opening tag
                    state = "inside";
                } else {
                    return "";
                }
            }

            if (state === "inside") {
                const closeMatch = buffer.match(CLOSE_RE);
                if (closeMatch) {
                    const out = buffer.slice(0, closeMatch.index);
                    buffer = "";
                    state = "after_close"; // Drop any accidental answer leaked after [[/REASON]]
                    return out;
                }
                if (buffer.length > 14) {
                    const out = buffer.slice(0, -14);
                    buffer = buffer.slice(-14);
                    return out;
                }
            }
            return "";
        },
        flush() {
            if (state !== "inside" || !buffer) {
                buffer = "";
                return "";
            }
            const rem = buffer.replace(OPEN_RE, "").replace(CLOSE_RE, "");
            buffer = "";
            return rem;
        },
    };
}

// Stream-safe router for Execution / Direct / Audit turns:
// - Routes any stray [[REASON]]...[[/REASON]] blocks to onReasoning (never leaks into assistant text!)
// - Swallows 【TOOL_CALL】...【/TOOL_CALL】 blocks
// - Strips 【END_RESPONSE】 control tags from user-visible content
function createExecutionStreamRouter({ onReasoning, onContent }) {
    const REASON_OPEN_RE = /\[\[RE[A-Z]*\]\]/i;
    const REASON_CLOSE_RE = /\[\[\/RE[A-Z]*\]\]/i;
    const TOOL_OPEN_RE = /(?:【|\[)TOOL_CALL/i;
    const TOOL_CLOSE_RE = /(?:【|\[)\/TOOL_CALL(?:】|\])/i;
    const END_TAG = "【END_RESPONSE】";

    let buffer = "";
    let state = "normal"; // "normal" | "in_reason" | "in_tool"

    const holdTailLength = (str) => {
        const candidates = ["[[REASON]]", "[[/REASON]]", "【TOOL_CALL", "[TOOL_CALL", "【END_RESPONSE】"];
        let maxKeep = 0;
        for (const tag of candidates) {
            const limit = Math.min(str.length, tag.length - 1);
            for (let len = limit; len > maxKeep; len--) {
                if (tag.toLowerCase().startsWith(str.slice(-len).toLowerCase())) {
                    maxKeep = len;
                }
            }
        }
        return maxKeep;
    };

    return {
        push(chunk) {
            if (!chunk) return;
            buffer += chunk;

            while (buffer.length > 0) {
                if (state === "in_reason") {
                    const closeMatch = buffer.match(REASON_CLOSE_RE);
                    if (closeMatch) {
                        const thoughtPart = buffer.slice(0, closeMatch.index);
                        if (thoughtPart) onReasoning?.(thoughtPart);
                        buffer = buffer.slice(closeMatch.index + closeMatch[0].length);
                        state = "normal";
                        continue;
                    }
                    if (buffer.length > 14) {
                        const emitLen = buffer.length - 14;
                        onReasoning?.(buffer.slice(0, emitLen));
                        buffer = buffer.slice(emitLen);
                    }
                    break;
                }

                if (state === "in_tool") {
                    const closeMatch = buffer.match(TOOL_CLOSE_RE);
                    if (closeMatch) {
                        buffer = buffer.slice(closeMatch.index + closeMatch[0].length);
                        state = "normal";
                        continue;
                    }
                    break;
                }

                // state === "normal"
                buffer = buffer.replace(/【END_RESPONSE】/g, "");
                if (!buffer) break;

                const rMatch = buffer.match(REASON_OPEN_RE);
                const tMatch = buffer.match(TOOL_OPEN_RE);

                const rIdx = rMatch ? rMatch.index : Infinity;
                const tIdx = tMatch ? tMatch.index : Infinity;

                if (rIdx === Infinity && tIdx === Infinity) {
                    const keep = holdTailLength(buffer);
                    const emitLen = buffer.length - keep;
                    if (emitLen > 0) {
                        onContent?.(buffer.slice(0, emitLen));
                        buffer = buffer.slice(emitLen);
                    }
                    break;
                }

                if (rIdx < tIdx) {
                    if (rIdx > 0) onContent?.(buffer.slice(0, rIdx));
                    buffer = buffer.slice(rIdx + rMatch[0].length);
                    state = "in_reason";
                } else {
                    if (tIdx > 0) onContent?.(buffer.slice(0, tIdx));
                    buffer = buffer.slice(tIdx);
                    state = "in_tool";
                }
            }
        },
        flush() {
            if (!buffer) return;
            if (state === "in_reason") {
                onReasoning?.(buffer);
            } else if (state === "normal") {
                const cleaned = buffer.replace(/【END_RESPONSE】/g, "");
                if (cleaned) onContent?.(cleaned);
            }
            buffer = "";
        },
    };
}

function extractAndStripProtocolTags(rawText = "") {
    const strayReasons = [];
    const withoutReasons = String(rawText || "").replace(
        /\[\[RE[A-Z]*\]\]([\s\S]*?)(?:\[\[\/RE[A-Z]*\]\]|$)/gi,
        (_, inner) => {
            const cleaned = sanitizeThoughtText(inner).trim();
            if (cleaned) strayReasons.push(cleaned);
            return "";
        },
    );
    const hasEndResponse = /【END_RESPONSE】/.test(withoutReasons);
    const textWithoutTags = withoutReasons.replace(/【END_RESPONSE】/g, "").trim();
    return { textWithoutTags, strayReasons, hasEndResponse };
}

function formatToolsSchema(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return "";
    return tools
        .map((t) => {
            const fn = t.function || t;
            const name = fn.name || "unknown";
            const desc = (fn.description || "").replace(/\s+/g, " ").trim();
            const params = fn.parameters ? JSON.stringify(fn.parameters) : "{}";
            return `- ${name}:${desc}\n  Parameters JSON Schema: ${params}`;
        })
        .join("\n\n");
}

function formatToolSignatures(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return "";
    return tools
        .map((t) => {
            const fn = t.function || t;
            const name = fn.name || "unknown";
            const props = fn.parameters?.properties ? Object.keys(fn.parameters.properties) : [];
            return `${name}(${props.join(", ")})`;
        })
        .join(", ");
}

function extractWorkspaceSkills(systemText = "") {
    const skills = [];
    // Match <skill><name>...</name><description>...</description></skill> or <skill name="...">
    const xmlRegex = /<skill(?:\s+name=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/skill>/gi;
    let m;
    while ((m = xmlRegex.exec(systemText)) !== null) {
        const attrName = m[1];
        const inner = m[2] || "";
        const tagNameMatch = inner.match(/<name>\s*([^<]+?)\s*<\/name>/i);
        const descMatch = inner.match(/<description>\s*([\s\S]*?)\s*<\/description>/i);
        const name = (attrName || tagNameMatch?.[1] || "").trim();
        const desc = (descMatch?.[1] || inner.replace(/<[^>]+>/g, " "))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        if (name) skills.push(`${name}: ${desc}`);
    }
    return skills.join("\n- ");
}

function stripOuterCodeFences(str) {
    let s = String(str || "").replace(/^\s*\r?\n|\r?\n\s*$/g, "");
    // 1. Standard <code-block> / <pre> triple backticks or middle-dot fences: ```html\n...\n```
    if (/^(?:```|···)[a-zA-Z0-9_-]*\s*\r?\n[\s\S]*\r?\n\s*(?:```|···)\s*$/.test(s)) {
        s = s
            .replace(/^(?:```|···)[a-zA-Z0-9_-]*\s*\r?\n/, "")
            .replace(/\r?\n\s*(?:```|···)\s*$/, "");
    }
    // 2. Fallback for single-backtick multi-line <code>html\n...\n</code>
    else if (/^`[a-zA-Z0-9_-]*\s*\r?\n[\s\S]*\r?\n\s*`\s*$/.test(s)) {
        s = s
            .replace(/^`[a-zA-Z0-9_-]*\s*\r?\n/, "")
            .replace(/\r?\n\s*`\s*$/, "");
    }
    // 3. Strip bare language header line left over from Gemini <code> tag (e.g. "html\n<!DOCTYPE html>...")
    s = s.replace(/^\s*(?:html|xml|svg)\s*\r?\n(?=\s*<)/i, "");
    return s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function cleanContentPayload(raw) {
    let s = String(raw || "");
    // Strip leading CONTENT_START even if Gemini omits ⟦ or ⟧ (e.g. "⟦CONTENT_START\n")
    s = s.replace(/^\s*(?:⟦|\[)?CONTENT_START(?:⟧|\])?\s*\r?\n?/i, "");
    // Strip trailing CONTENT_END even if Gemini omits ⟦ or ⟧
    s = s.replace(/\r?\n?\s*(?:⟦|\[)?CONTENT_END(?:⟧|\])?\s*$/i, "");
    return stripOuterCodeFences(s);
}

function parseToolCalls(rawText) {
    const toolCalls = [];
    // Tolerant regex: matches closing 【/TOOL_CALL】 OR falls back to end-of-string if Gemini omitted closing tag after a huge code block
    const regex = /(?:【|\[)TOOL_CALL\s+name=["']?([^"'\s】\]]+)["']?\s*(?:】|\])([\s\S]*?)(?:(?:【|\[)\/TOOL_CALL(?:】|\])|$)/gi;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
        const name = match[1].trim().replace(/^default_api:/i, "");
        let rawArgs = match[2].trim();
        if (!rawArgs) continue;

        let argsObject = null;

        // Handle ⟦CONTENT_START⟧ ... (optional ⟦CONTENT_END⟧) blocks robustly
        const startMarkerIdx = rawArgs.indexOf("⟦CONTENT_START⟧");
        if (startMarkerIdx !== -1) {
            const beforeMarker = rawArgs.slice(0, startMarkerIdx);
            let afterMarker = rawArgs.slice(startMarkerIdx + "⟦CONTENT_START⟧".length);

            const endMarkerIdx = afterMarker.indexOf("⟦CONTENT_END⟧");
            let afterEnd = "";
            if (endMarkerIdx !== -1) {
                afterEnd = afterMarker.slice(endMarkerIdx + "⟦CONTENT_END⟧".length);
                afterMarker = afterMarker.slice(0, endMarkerIdx);
            } else {
                // Gemini omitted ⟦CONTENT_END⟧ at the end of a long code block; trim trailing JSON closing tokens
                afterMarker = afterMarker.replace(/(?:\s*```\s*)?(?:["”]\s*\}\s*)?$/, "");
                afterEnd = '"}';
            }

            const cleanInner = stripOuterCodeFences(afterMarker);
            const reconstructedJson = `${beforeMarker}${JSON.stringify(cleanInner).slice(1, -1)}${afterEnd}`;

            try {
                argsObject = JSON.parse(reconstructedJson);
            } catch (_) {
                // Fallback: extract sibling string fields (like file_path / path) via regex if JSON syntax was slightly mangled
                const pathMatch = beforeMarker.match(/"(?:file_path|path|filename)"\s*:\s*"([^"]+)"/i);
                argsObject = pathMatch
                    ? { file_path: pathMatch[1], content: cleanInner }
                    : { content: cleanInner };
            }

            if (argsObject && typeof argsObject.content === "string") {
                argsObject.content = cleanContentPayload(argsObject.content);
            }
        } else {
            try {
                argsObject = JSON.parse(rawArgs);
            } catch (_) {
                // JSON parse failed: try to extract file_path and content via relaxed regex
                const fpMatch = rawArgs.match(/"file_path"\s*:\s*"([^"]+)"/);
                const contentKeyMatch = rawArgs.match(/"content"\s*:\s*"/);
                if (fpMatch && contentKeyMatch) {
                    let afterKey = rawArgs.slice(contentKeyMatch.index + contentKeyMatch[0].length);
                    // Strip trailing closing quote + brace: "}
                    afterKey = afterKey.replace(/"\s*\}\s*$/, "");
                    // Unescape JSON string escapes if Gemini escaped newlines/quotes
                    if (!afterKey.includes("\n") && afterKey.includes("\\n")) {
                        try {
                            afterKey = JSON.parse(`"${afterKey}"`);
                        } catch (_) {
                            afterKey = afterKey
                                .replace(/\\n/g, "\n")
                                .replace(/\\r/g, "\r")
                                .replace(/\\t/g, "\t")
                                .replace(/\\"/g, '"')
                                .replace(/\\\\/g, "\\");
                        }
                    } else {
                        afterKey = afterKey
                            .replace(/\\n/g, "\n")
                            .replace(/\\r/g, "\r")
                            .replace(/\\t/g, "\t")
                            .replace(/\\"/g, '"')
                            .replace(/\\\\/g, "\\");
                    }
                    argsObject = {
                        file_path: fpMatch[1],
                        content: cleanContentPayload(afterKey),
                    };
                } else {
                    argsObject = { input: rawArgs };
                }
            }

            if (argsObject && typeof argsObject.content === "string") {
                argsObject.content = cleanContentPayload(argsObject.content);
            }
        }

        toolCalls.push({
            id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
                name,
                arguments: JSON.stringify(argsObject),
            },
        });
    }

    const cleanText = rawText.replace(regex, "").trim();
    return { toolCalls, cleanText };
}

function hashText(str) {
    return crypto.createHash("sha256").update(str || "").digest("hex").slice(0, 16);
}

function buildHandoffSummary(convoTurns) {
    if (!Array.isArray(convoTurns) || convoTurns.length === 0) return "";
    const recent = convoTurns.slice(-8);
    const lines = [];
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        const t = recent[i];
        const snippet = t.text.length > 1200 ? `${t.text.slice(0, 1200)}\n...[truncated]` : t.text;
        const entry = `[${t.roleLabel}]:\n${snippet}`;
        if (total + entry.length > 4500) break;
        lines.unshift(entry);
        total += entry.length;
    }
    return lines.join("\n\n---\n\n");
}

async function formatIncomingMessages(body = {}, forceNewChat = false, headers = {}) {
    const systemParts = [];
    const convoTurns = [];
    const perMsgFiles = []; // index -> array of files/images belonging to that raw message

    if (body.system) {
        const sysText = extractTextFromContent(body.system);
        if (sysText) systemParts.push(sysText);
    }

    const messages = Array.isArray(body.messages)
        ? body.messages
        : typeof body.prompt === "string"
          ? [{ role: "user", content: body.prompt }]
          : [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = (msg.role || "user").toLowerCase();
        const roleLabel =
            role === "tool" ? `TOOL_RESULT (${msg.tool_call_id || msg.name || "tool"})` : role.toUpperCase();
        let textContent = "";
        const msgFiles = [];

        if (typeof msg.content === "string") {
            textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === "text") {
                    textContent += part.text || "";
                } else if (part.type === "image_url" || part.type === "image") {
                    const imgFile = await parseImagePart(part);
                    if (imgFile) msgFiles.push(imgFile);
                } else if (part.type === "file" && part.file) {
                    msgFiles.push({
                        fileName: part.file.filename || "attachment.txt",
                        content: part.file.file_data,
                        mimeType: "text/plain",
                        isBase64: false,
                    });
                } else if (part.type === "tool_result") {
                    textContent += extractTextFromContent(part.content);
                }
            }
        }

        if (Array.isArray(msg.images)) {
            for (const b64 of msg.images) {
                if (typeof b64 === "string" && b64.length > 0) {
                    msgFiles.push({
                        fileName: `image_${crypto.randomUUID().slice(0, 8)}.png`,
                        content: b64,
                        mimeType: "image/png",
                        isBase64: true,
                    });
                }
            }
        }

        if (!textContent && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            textContent = msg.tool_calls
                .map((tc) => `[Called ${tc.function?.name}(${tc.function?.arguments || "{}"})]`)
                .join("\n");
        }

        perMsgFiles[i] = msgFiles;

        if (!textContent && msgFiles.length === 0) continue;

        if (role === "system" || role === "developer") {
            if (textContent) systemParts.push(textContent);
        } else {
            convoTurns.push({
                rawIndex: i,
                role,
                roleLabel,
                text: textContent || (msgFiles.length > 0 ? "[Attached media/files]" : ""),
            });
        }
    }

    const toolsSchema = formatToolsSchema(body.tools);
    const hasTools = Boolean(toolsSchema);
    const toolNamesList = Array.isArray(body.tools)
        ? body.tools.map((t) => (t.function || t).name).filter(Boolean).join(", ")
        : "";
    const toolSignatures = formatToolSignatures(body.tools);
    const systemText = systemParts.join("\n\n---\n\n");
    const workspaceSkillsList = extractWorkspaceSkills(systemText);

    const firstUserRaw = convoTurns.find((t) => t.role === "user")?.text || "";
    const isTitleGenRequest =
        !hasTools &&
        convoTurns.length <= 2 &&
        (/generate (the |a )?(session |concise |short )?title|summarize.*title|title for this|generate.*title|create.*title/i.test(systemText) ||
            /generate (the |a )?(session |concise |short )?title|summarize.*title|title for this|generate.*title|create.*title/i.test(firstUserRaw));

    if (isTitleGenRequest) {
        const topicMatch = firstUserRaw.match(/(?:user|message|conversation)[:\s]+([^\n]{1,60})/i);
        const autoTitle = (topicMatch ? topicMatch[1] : firstUserRaw.slice(0, 30)).trim() || "New Chat";
        return {
            prompt: "",
            files: [],
            hasTools: false,
            toolNamesList: "",
            toolSignatures,
            workspaceSkillsList,
            isContinuation: false,
            shouldOpenGhostChat: false,
            isEphemeral: true,
            localTitleResponse: autoTitle.replace(/[\r\n"#*]+/g, "").slice(0, 40),
        };
    }

    const currentTabId = activeTab?.id || null;
    const needsRefresh = Boolean(ghostSession?.needsRefresh);
    const shouldOpenGhostChat = Boolean(forceNewChat || needsRefresh);
    const clientSessionId =
        headers["x-session-id"] ||
        headers["x-conversation-id"] ||
        body?.metadata?.session_id ||
        body?.session_id ||
        null;

    // Normalize all non-assistant turns for strict prefix matching
    const normalizedNonAssistant = convoTurns
        .filter((t) => t.role !== "assistant")
        .map((t) => `${t.role}:${normalizeTurnFingerprint(t.text)}`)
        .filter((entry) => !entry.endsWith(":"));

    const prevNonAssistant = Array.isArray(ghostSession?.nonAssistantTurns)
        ? ghostSession.nonAssistantTurns
        : [];

    // Strict survival check: same tab, same session id, strict prefix match, and strictly more turns
    const isSameSessionId =
        !clientSessionId ||
        !ghostSession?.clientSessionId ||
        clientSessionId === ghostSession.clientSessionId;

    const isStrictPrefixMatch =
        prevNonAssistant.length > 0 &&
        normalizedNonAssistant.length > prevNonAssistant.length &&
        prevNonAssistant.every((prevTurn, idx) => normalizedNonAssistant[idx] === prevTurn);

    let canContinue = false;
    if (
        !forceNewChat &&
        ghostSession &&
        !needsRefresh &&
        currentTabId &&
        ghostSession.tabId === currentTabId &&
        convoTurns.length > (ghostSession.sentTurnCount || 0) &&
        isSameSessionId &&
        isStrictPrefixMatch
    ) {
        canContinue = true;
    }

    // ---- CASE 1: Confirmed same-session continuation -> send ONLY incremental turns ----
    if (canContinue) {
        const newTurns = convoTurns
            .slice(ghostSession.sentTurnCount)
            .filter((t) => t.role !== "assistant");

        const newFiles = [];
        for (const t of newTurns) {
            if (Array.isArray(perMsgFiles[t.rawIndex])) {
                newFiles.push(...perMsgFiles[t.rawIndex]);
            }
        }

        const deltaText = newTurns
            .map((t) => (t.role === "user" ? t.text : `[${t.roleLabel}]:\n${t.text}`))
            .join("\n\n");

        ghostSession.sentTurnCount = convoTurns.length;
        ghostSession.nonAssistantTurns = normalizedNonAssistant;

        return {
            prompt: deltaText,
            files: newFiles,
            hasTools,
            isContinuation: true,
            shouldOpenGhostChat: false,
            isEphemeral: false,
            toolNamesList,
            toolSignatures,
            workspaceSkillsList,
        };
    }

    // ---- CASE 2: New session / cold start / prefix mismatch / watermark -> Fresh Ghost Chat ----
    console.log(
        `[SESSION] Starting fresh Ghost Chat (forceNew=${forceNewChat}, needsRefresh=${needsRefresh}, prefixMatch=${isStrictPrefixMatch}, prevTurns=${prevNonAssistant.length}, currTurns=${normalizedNonAssistant.length})`,
    );
    const latestTurn = convoTurns.length > 0 ? convoTurns[convoTurns.length - 1] : null;
    const historyTurns = convoTurns.length > 1 ? convoTurns.slice(0, -1) : [];
    const files =
        latestTurn && Array.isArray(perMsgFiles[latestTurn.rawIndex])
            ? [...perMsgFiles[latestTurn.rawIndex]]
            : [];

    const contextSections = [];
    if (systemText) {
        contextSections.push(`=== WORKSPACE & ASSISTANT GUIDELINES ===\n${systemText}`);
    }
    if (toolsSchema) {
        contextSections.push(`=== AVAILABLE FUNCTIONS ===\n${toolsSchema}`);
    }
    if (historyTurns.length > 0) {
        const historyText = needsRefresh
            ? buildHandoffSummary(historyTurns)
            : historyTurns.map((t) => `[${t.roleLabel}]:\n${t.text}`).join("\n\n---\n\n");
        if (historyText) {
            contextSections.push(
                needsRefresh
                    ? `=== CONTEXT HANDOFF (AUTO-REFRESHED GHOST SESSION) ===\n${historyText}`
                    : `=== PRIOR CONVERSATION HISTORY ===\n${historyText}`,
            );
        }
    }

    const formatRules = [CODE_FENCE_RULE];
    if (hasTools) formatRules.push(TOOL_PROTOCOL_RULE);
    contextSections.push(`=== OUTPUT & TOOL RULES ===\n${formatRules.join("\n\n")}`);

    const contextFileContent = contextSections.join("\n\n========================================\n\n");
    files.unshift({
        fileName: "workspace_spec.txt",
        content: contextFileContent,
        mimeType: "text/plain",
        isBase64: false,
    });

    const hasImageAttachment = files.some((f) => f.isBase64);
    let prompt = "";
    if (latestTurn) {
        const bodyText =
            latestTurn.role === "user"
                ? latestTurn.text
                : `[${latestTurn.roleLabel}]:\n${latestTurn.text}`;
        prompt = hasImageAttachment
            ? `${bodyText}\n\n(Refer to workspace_spec.txt for response formatting, and inspect the attached image directly.)`
            : `${bodyText}\n\n(Refer to workspace_spec.txt for response and function formatting.)`;
    } else {
        prompt = "Please refer to the attached workspace_spec.txt.";
    }

    ghostSession = {
        tabId: currentTabId,
        clientSessionId,
        sentTurnCount: convoTurns.length,
        nonAssistantTurns: normalizedNonAssistant,
        cumulativeChars: prompt.length + contextFileContent.length,
        needsRefresh: false,
    };

    return {
        prompt,
        files,
        hasTools,
        isContinuation: false,
        shouldOpenGhostChat: true,
        isEphemeral: false,
        toolNamesList,
        toolSignatures,
        workspaceSkillsList,
    };
}

function detectProtocol(req) {
    const p = req.path.toLowerCase();
    if (
        p.endsWith("/messages") ||
        p.endsWith("/claude") ||
        p.includes("/claude/") ||
        p.includes("/anthropic/") ||
        Boolean(req.headers["anthropic-version"])
    ) {
        return "claude";
    }
    if (
        p.endsWith("/api/chat") ||
        p.endsWith("/api/generate") ||
        p.endsWith("/ollama") ||
        p.includes("/ollama/")
    ) {
        return "ollama";
    }
    return "openai";
}

function createOpenAIChunk(id, created, model, deltaContent = null, finishReason = null) {
    return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
            {
                index: 0,
                delta: deltaContent !== null ? { content: deltaContent } : {},
                logprobs: null,
                finish_reason: finishReason,
            },
        ],
    };
}

function createOllamaChunk(
    model,
    content = "",
    done = false,
    isGenerate = false,
    metrics = {},
) {
    return {
        model,
        created_at: new Date().toISOString(),
        ...(isGenerate
            ? { response: content }
            : { message: { role: "assistant", content } }),
        done,
        ...(done
            ? {
                  done_reason: "stop",
                  total_duration: metrics.totalDurationNs ?? 1000000,
                  load_duration: 100000,
                  prompt_eval_count: metrics.inputTokens ?? 0,
                  prompt_eval_duration: 100000,
                  eval_count: metrics.outputTokens ?? 0,
                  eval_duration: metrics.totalDurationNs ?? 900000,
              }
            : {}),
    };
}

// ==========================================
// 3. OpenAI-Compatible HTTP Gateway
// ==========================================
const app = express();
app.use(express.json({ limit: "25mb" }));

// CORS support for browser-based UIs (e.g., Open WebUI, LibreChat)
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// ==========================================
// 1b. Bridge endpoints used by the userscript
// ==========================================

// Long-poll: holds the request until a command is available (or 204 after POLL_HOLD_MS).
// A request only registers the tab; it is never turned away for being a helper
// frame, otherwise that tab would retry in a tight loop forever.
app.get("/bridge/poll", (req, res) => {
    const tabId = String(req.query.tab || "");
    const href = String(req.query.href || "");
    const claim = req.query.claim === "1";
    const isHelper = req.query.top !== "1" || /gemini\.google\.com\/_\//.test(href);

    if (!isHelper) {
        const isExpired = !activeTab || Date.now() - activeTab.lastPoll >= TAB_TIMEOUT_MS;
        if (claim || isExpired) {
            if (!activeTab || activeTab.id !== tabId) {
                console.log(`[TAB] poll registered: top=${req.query.top} ${href}`);
                console.log(`[TAB] Gemini tab active at: ${href}`);
            }
            activeTab = { id: tabId, href, lastPoll: Date.now() };
        } else if (activeTab.id !== tabId) {
            return res.json({ replaced: true });
        }
    }

    if (isHelper) {
        if (!wsLogged.has(tabId)) {
            wsLogged.add(tabId);
            console.log(`[TAB] Helper frame polling (ignored): top=${req.query.top} ${href}`);
        }
        return res.status(204).end();
    }

    activeTab.lastPoll = Date.now();

    if (outbox.length > 0) {
        const batch = outbox;
        outbox = [];
        console.log(`[TAB] -> ${batch.map((c) => `${c.command}#${c.id}`).join(", ")}`);
        return res.json({ commands: batch });
    }

    res.status(204).end();
});

// Messages from the page: report_existence, ack, error, message_stream, message_completed.
app.post("/bridge/message", (req, res) => {
    res.status(204).end();
    if (activeTab && req.body?.tabId === activeTab.id) activeTab.lastPoll = Date.now();
    handleIncoming(req.body || {}).catch((err) => console.error("[TAB] Failed to handle message:", err));
});

// Health check
app.get("/health", (req, res) => {
    res.json({
        connected: Boolean(tab()),
        busy: isBusy,
    });
});

// ==========================================
// 3b. Universal Model Discovery & Chat Endpoints
//     Matches any prefix: /, /v1, /openai, /open-ai, /ollama, /claude
// ==========================================

// OpenAI & Claude model list
app.get(/\/models$/, (req, res) => {
    res.json({
        object: "list",
        data: [
            {
                id: "gemini-web",
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "google-web-bridge",
            },
        ],
    });
});

// Ollama model list & version
app.get(/\/api\/tags$/, (req, res) => {
    res.json({
        models: [
            {
                name: "gemini-web",
                model: "gemini-web",
                modified_at: new Date().toISOString(),
                size: 0,
                digest: "gemini-web",
                details: {
                    format: "gguf",
                    family: "gemini",
                    parameter_size: "web",
                    quantization_level: "none",
                },
            },
        ],
    });
});

app.get(/\/api\/version$/, (req, res) => {
    res.json({ version: "0.5.0" });
});

// Universal Chat / Messages / Generate handler
app.post(
    /\/(chat\/completions|api\/chat|api\/generate|messages|openai|open-ai|ollama|claude)$/,
    handleChatCompletion,
);

let lastGeminiTurnEndAt = 0;

async function waitTurnCooldown(abortState) {
    const elapsed = Date.now() - lastGeminiTurnEndAt;
    if (elapsed < TURN_COOLDOWN_MS) {
        await new Promise((r) => setTimeout(r, TURN_COOLDOWN_MS - elapsed));
    }
    if (abortState.aborted) throw new Error("Client aborted request");
}

// Check if an error from the Gemini web bridge is transient / retryable
function isTransientBridgeError(errMsg = "") {
    return /(?:having a hard time fulfilling your request|encountered an error doing what you asked|Sorry, something went wrong|Something went wrong|Something went wrong \(1095\)|\(1095\)|Rate limit|rate limit|An error occurred|problem generating a response|Error generating response|Unable to reach|Network error|offline|stopped responding with empty output|stalled|timed out|網路錯誤|網絡錯誤|發生錯誤|发生错误)/i.test(
        String(errMsg),
    );
}

// Execute a single prompt/response turn against the Gemini web tab (with auto-retry on transient web errors)
async function runSingleGeminiTurn({
    promptText,
    files = [],
    thinkingLevel = "medium",
    onCleanDelta,
    abortState,
    maxRetries = 3,
}) {
    await waitTurnCooldown(abortState);

    const attachAllFiles = async () => {
        for (const file of files) {
            if (abortState.aborted) throw new Error("Client aborted request");
            await performAction(
                "add_file",
                {
                    fileName: file.fileName,
                    content: file.content,
                    mimeType: file.mimeType || "text/plain",
                    isBase64: Boolean(file.isBase64),
                },
                60000,
            );
        }
    };

    await attachAllFiles();

    let attempt = 0;
    while (true) {
        if (abortState.aborted) throw new Error("Client aborted request");

        if (attempt > 0) {
            const backoffMs = Math.min(attempt * 2500, 8000);
            console.log(`[RETRY] Gemini Web error; retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, backoffMs));
            if (abortState.aborted) throw new Error("Client aborted request");

            // 第 2 次及以後重試：若帶有初始檔案或前次對話已卡死，直接開新 Ghost Chat 重傳完整上下文
            if (attempt >= 2 && files.length > 0) {
                console.log("[RETRY] Rebuilding fresh Ghost Chat and re-attaching files...");
                await performAction("new_chat");
                if (ghostSession && activeTab?.id) ghostSession.tabId = activeTab.id;
                await attachAllFiles();
            }
        }

        if (promptText) {
            const textToSend =
                attempt === 0 || (attempt >= 2 && files.length > 0)
                    ? promptText
                    : "The previous attempt encountered a temporary system error. Please try again and fulfill the previous instruction now.";

            // Configurable delay before sending prompt to Gemini web (helps avoid rate limits)
            if (BRIDGE_SEND_DELAY_MS > 0) {
                console.log(`[DELAY] Waiting ${BRIDGE_SEND_DELAY_MS}ms before sending prompt to Gemini web...`);
                await new Promise((r) => setTimeout(r, BRIDGE_SEND_DELAY_MS));
            }

            await performAction("prompt", { text: textToSend, thinkingLevel });
        }

        try {
            return await new Promise((resolve, reject) => {
                const fenceTransformer = createDotFenceTransformer();
                let fullCleanText = "";
                let lastActivityAt = Date.now();
                let settled = false;

                const TAB_OFFLINE_TIMEOUT_MS = 15000;
                const STREAM_STALL_TIMEOUT_MS = 180000;

                const cleanupTurn = () => {
                    settled = true;
                    clearInterval(watchdog);
                    bridgeEvents.off("delta", onRawDelta);
                    bridgeEvents.off("completed", onTurnCompleted);
                    bridgeEvents.off("bridge_error", onTurnError);
                    lastGeminiTurnEndAt = Date.now();
                };

                const watchdog = setInterval(() => {
                    if (settled) return;
                    if (abortState.aborted) {
                        cleanupTurn();
                        reject(new Error("Client aborted request"));
                        return;
                    }
                    const pollAge = activeTab ? Date.now() - activeTab.lastPoll : Infinity;
                    if (!activeTab || pollAge > TAB_OFFLINE_TIMEOUT_MS) {
                        console.error(`[WATCHDOG] Tab offline during generation (lastPoll=${pollAge}ms ago).`);
                        cleanupTurn();
                        reject(new Error("Gemini tab lost connection (network disconnected or tab closed)."));
                        return;
                    }
                    const idleMs = Date.now() - lastActivityAt;
                    if (idleMs > STREAM_STALL_TIMEOUT_MS) {
                        console.error(`[WATCHDOG] Stream stalled for ${idleMs}ms; aborting turn.`);
                        try {
                            fireAndForget("stop_response");
                        } catch (_) {}
                        cleanupTurn();
                        reject(new Error(`Gemini response stalled for ${Math.round(idleMs / 1000)}s.`));
                    }
                }, 2000);

                const onRawDelta = (rawDelta) => {
                    if (abortState.aborted || settled) return;
                    lastActivityAt = Date.now();
                    const clean = fenceTransformer.push(rawDelta);
                    if (clean) {
                        fullCleanText += clean;
                        onCleanDelta?.(clean);
                    }
                };

                const onTurnCompleted = (finalText) => {
                    if (settled) return;
                    const rem = fenceTransformer.flush();
                    if (rem) {
                        fullCleanText += rem;
                        onCleanDelta?.(rem);
                    }
                    if (typeof finalText === "string" && finalText.trim().length > 0) {
                        const finalTransformer = createDotFenceTransformer();
                        fullCleanText = finalTransformer.push(finalText) + finalTransformer.flush();
                    }
                    cleanupTurn();
                    recordSessionChars((promptText || "").length + fullCleanText.length);
                    resolve(fullCleanText);
                };

                const onTurnError = (data) => {
                    if (settled) return;
                    cleanupTurn();
                    reject(new Error(data?.message || "Bridge error during generation"));
                };

                bridgeEvents.on("delta", onRawDelta);
                bridgeEvents.on("completed", onTurnCompleted);
                bridgeEvents.on("bridge_error", onTurnError);

                performAction("start_completion", {}, 35000).catch((err) => {
                    if (!settled) {
                        cleanupTurn();
                        reject(err);
                    }
                });
            });
        } catch (err) {
            if (attempt < maxRetries && isTransientBridgeError(err.message) && !abortState.aborted) {
                attempt++;
                // Rate limit: slow down with longer cooldown and notify client
                const isRateLimit = /(?:1095|Rate limit|rate limit)/i.test(err.message || "");
                if (isRateLimit) {
                    const slowDownMs = Math.min(10000 + attempt * 5000, 30000);
                    console.log(`[RATE LIMIT] ${err.message}; slowing down for ${slowDownMs}ms before retry ${attempt}/${maxRetries}`);
                    try {
                        onCleanDelta?.(`\n\n**[Bridge] Reached Gemini Rate Limit, Slowing Down...** (retry ${attempt}/${maxRetries})\n\n`);
                    } catch (_) {}
                    await new Promise((r) => setTimeout(r, slowDownMs));
                } else {
                    const backoffMs = Math.min(attempt * 2500, 8000);
                    console.log(`[RETRY] Gemini Web error; retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})...`);
                    await new Promise((r) => setTimeout(r, backoffMs));
                }
                if (abortState.aborted) throw new Error("Client aborted request");
                continue;
            }
            throw err;
        }
    }
}

function resolveThinkingLevel(body = {}) {
    // Explicit disable flags sent by DeepSeek Harness / OpenAI / Anthropic / OpenRouter clients
    if (body.enable_thinking === false) return "off";
    if (body.thinking?.type === "disabled") return "off";
    if (body.reasoning?.enabled === false || body.reasoning?.exclude === true) return "off";

    const raw =
        body.thinking_level ??
        body.reasoning_effort ??
        body.reasoning?.effort ??
        body.extra_body?.reasoning_effort ??
        body.extra_body?.thinking_level;

    // When client selects "Off", many UIs omit reasoning_effort completely -> default to "off"
    if (raw === undefined || raw === null || raw === "") {
        return "off";
    }

    const lvl = String(raw).toLowerCase().trim();
    if (["off", "none", "disabled", "false", "0"].includes(lvl)) return "off";
    if (["low", "minimal"].includes(lvl)) return "low";
    if (["high", "xhigh", "max"].includes(lvl)) return "high";
    return "medium";
}

function getThinkingConfig(thinkingLevel) {
    switch (thinkingLevel) {
        case "off":
            return { mode: "off", thoughtRounds: 0 };
        case "high":
            return { mode: "high", thoughtRounds: 2 };
        case "low":
        case "medium":
        default:
            return { mode: thinkingLevel, thoughtRounds: 1 };
    }
}

async function handleChatCompletion(req, res) {
    const {
        messages,
        prompt: rawPrompt,
        model = "gemini-web",
        stream,
        reasoning_effort,
        thinking_level,
        new_chat = false,
    } = req.body || {};

    const thinkingLevel = resolveThinkingLevel(req.body);
    const thinkingConfig = getThinkingConfig(thinkingLevel);
    const maxReflectionRounds = thinkingConfig.thoughtRounds;
    const protocol = detectProtocol(req);
    const isGenerate = req.path.toLowerCase().endsWith("/api/generate");

    if (!Array.isArray(messages) && typeof rawPrompt !== "string") {
        return res.status(400).json({
            type: "error",
            error: {
                message: "'messages' (or 'prompt') must be provided.",
                type: "invalid_request_error",
            },
        });
    }

    await acquireBridgeLock();

    const effectiveStream =
        stream !== false || Boolean(req.headers.accept?.includes("text/event-stream"));

    console.log(
        "[CHAT]",
        req.path,
        "protocol=",
        protocol,
        "stream=",
        effectiveStream,
        "thinking=",
        thinkingLevel,
        "minRounds=",
        thinkingConfig.minRounds,
        "maxRounds=",
        maxReflectionRounds,
        "model=",
        model,
        "messages=",
        messages?.length ?? (rawPrompt ? 1 : 0),
    );

    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const claudeMsgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const startTimeNs = process.hrtime.bigint();
    let inputTokens = 0;

    const abortState = { aborted: false };
    const onClientAbort = () => {
        if (res.writableFinished) return;
        abortState.aborted = true;
        try {
            fireAndForget("stop_response");
        } catch (_) {}
    };
    res.on("close", onClientAbort);

    // Prepare SSE / NDJSON headers if streaming
    if (effectiveStream) {
        if (protocol === "ollama") {
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        } else {
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        }
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        if (protocol === "openai") {
            const initChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(initChunk)}\n\n`);
        } else if (protocol === "claude") {
            const msgStart = {
                type: "message_start",
                message: {
                    id: claudeMsgId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                },
            };
            res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);
        }
    }

    let claudeTextBlockStarted = false;
    let totalReasoningChars = 0;
    let totalOutputChars = 0;

    const emitReasoning = (rawText) => {
        const text = sanitizeThoughtText(rawText);
        if (!text || abortState.aborted) return;
        totalReasoningChars += text.length;
        if (!effectiveStream) return;

        if (protocol === "openai") {
            const chunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                    {
                        index: 0,
                        delta: { reasoning_content: text },
                        logprobs: null,
                        finish_reason: null,
                    },
                ],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        } else if (protocol === "ollama") {
            const chunk = {
                model,
                created_at: new Date().toISOString(),
                message: { role: "assistant", content: "", thinking: text },
                done: false,
            };
            res.write(`${JSON.stringify(chunk)}\n`);
        }
    };

    const emitContent = (text) => {
        if (!text || abortState.aborted) return;
        totalOutputChars += text.length;
        if (!effectiveStream) return;

        if (protocol === "ollama") {
            res.write(`${JSON.stringify(createOllamaChunk(model, text, false, isGenerate))}\n`);
        } else if (protocol === "claude") {
            if (!claudeTextBlockStarted) {
                claudeTextBlockStarted = true;
                res.write(
                    `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "text", text: "" },
                    })}\n\n`,
                );
            }
            res.write(
                `event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text },
                })}\n\n`,
            );
        } else {
            const chunk = createOpenAIChunk(completionId, created, model, text, null);
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
    };

    try {
        const {
            prompt,
            files,
            hasTools,
            isContinuation,
            shouldOpenGhostChat,
            isEphemeral,
            toolSignatures,
            toolNamesList,
            workspaceSkillsList,
            localTitleResponse,
        } = await formatIncomingMessages(req.body, Boolean(new_chat), req.headers);

        console.log(
            `[SESSION] mode=${isContinuation ? "delta" : "ghost_inject"} tabId=${activeTab?.id || "none"} files=${files.length} tools=${hasTools}`,
        );

        // Local title-generation request: answer directly without touching the Gemini page or ghostSession
        if (localTitleResponse) {
            const localTitleTokens = await countGeminiTokensExact(localTitleResponse);
            if (effectiveStream) {
                if (protocol === "ollama") {
                    res.write(`${JSON.stringify(createOllamaChunk(model, localTitleResponse, false, isGenerate))}\n`);
                    res.write(`${JSON.stringify(createOllamaChunk(model, "", true, isGenerate))}\n`);
                } else if (protocol === "claude") {
                    res.write(
                        `event: content_block_start\ndata: ${JSON.stringify({
                            type: "content_block_start",
                            index: 0,
                            content_block: { type: "text", text: "" },
                        })}\n\n`,
                    );
                    res.write(
                        `event: content_block_delta\ndata: ${JSON.stringify({
                            type: "content_block_delta",
                            index: 0,
                            delta: { type: "text_delta", text: localTitleResponse },
                        })}\n\n`,
                    );
                    res.write(
                        `event: content_block_stop\ndata: ${JSON.stringify({
                            type: "content_block_stop",
                            index: 0,
                        })}\n\n`,
                    );
                    res.write(
                        `event: message_delta\ndata: ${JSON.stringify({
                            type: "message_delta",
                            delta: { stop_reason: "end_turn", stop_sequence: null },
                            usage: { output_tokens: localTitleTokens },
                        })}\n\n`,
                    );
                    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                } else {
                    const chunk = createOpenAIChunk(completionId, created, model, localTitleResponse, null);
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    const stopChunk = createOpenAIChunk(completionId, created, model, null, "stop");
                    res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                    res.write("data: [DONE]\n\n");
                }
                res.end();
                return;
            }
            return res.json({
                id: completionId,
                object: "chat.completion",
                created,
                model,
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: localTitleResponse },
                        logprobs: null,
                        finish_reason: "stop",
                    },
                ],
            });
        }

        const textFilesTokens = files
            .filter((f) => !f.isBase64)
            .reduce((sum, f) => sum + estimateTokens(f.content || ""), 0);
        const imageCount = files.filter((f) => f.isBase64).length;
        inputTokens = await countGeminiTokensExact(prompt || "", imageCount) + textFilesTokens;

        // Open a clean Ghost Mode (Temporary Chat) window whenever context needs cold injection
        if (!isEphemeral && shouldOpenGhostChat) {
            console.log("[SESSION] Opening a fresh Ghost Mode (Temporary Chat) window...");
            await performAction("new_chat");
            if (ghostSession && activeTab?.id) {
                ghostSession.tabId = activeTab.id;
            }
        }

        let finalRawResponse = "";
        let fullReasoningAccumulated = "";
        const execRouter = createExecutionStreamRouter({
            onReasoning: (thoughtDelta) => {
                fullReasoningAccumulated += thoughtDelta;
                emitReasoning(thoughtDelta);
            },
            onContent: (safeText) => emitContent(safeText),
        });
        const streamDeltaHandler = (delta) => execRouter.push(delta);

        // 2. Direct single-turn mode when thinking_level is "off"
        if (maxReflectionRounds === 0) {
            const skillHint = workspaceSkillsList
                ? `\n[Available Workspace Skills — call via 【TOOL_CALL name="skill"】 ONLY, ignore built-in web skills]:\n- ${workspaceSkillsList}\n`
                : "";
            const directPrompt = hasTools
                ? `${prompt}${skillHint}\n\n(REMINDER: Active bridge tools available: ${toolNamesList}. Never claim you lack local file tools. Output 【TOOL_CALL name="..."】{...}【/TOOL_CALL】 when invoking tools, or append 【END_RESPONSE】 when finishing a pure text answer. Use ··· instead of three backticks for code blocks.)`
                : `${prompt}${skillHint}\n\n(Use ··· instead of three backticks for code blocks, and append 【END_RESPONSE】 at the end of your response.)`;

            finalRawResponse = await runSingleGeminiTurn({
                promptText: directPrompt,
                files,
                thinkingLevel,
                onCleanDelta: streamDeltaHandler,
                abortState,
            });
            if (ghostSession && activeTab?.id) ghostSession.tabId = activeTab.id;
        } else {
            // Multi-round iterative reflection
            console.log("[THINK] Round 1: Initial deep thought...");
            const stripper1 = createThoughtTagStripper();
            const skillHint = workspaceSkillsList
                ? `\n[Available Workspace Skills — call via 【TOOL_CALL name="skill"】 ONLY, ignore built-in web skills]:\n- ${workspaceSkillsList}\n`
                : "";
            const firstPrompt = `${prompt}${skillHint}\n${INITIAL_THOUGHT_PROMPT}`;

            const round1Raw = await runSingleGeminiTurn({
                promptText: firstPrompt,
                files,
                thinkingLevel,
                onCleanDelta: (delta) => {
                    const cleanThought = stripper1.push(delta);
                    if (cleanThought) {
                        fullReasoningAccumulated += cleanThought;
                        emitReasoning(cleanThought);
                    }
                },
                abortState,
            });
            const rem1 = stripper1.flush();
            if (rem1) {
                fullReasoningAccumulated += rem1;
                emitReasoning(rem1);
            }

            // Check if Gemini prematurely emitted 【TOOL_CALL】 right after [[/REASON]] in Round 1
            if (hasTools && parseToolCalls(round1Raw).toolCalls.length > 0) {
                console.log("[THINK] Captured premature 【TOOL_CALL】 emitted in Round 1; skipping remaining rounds.");
                finalRawResponse = round1Raw;
            } else {
                // High mode: 1 critical rethink round before execution
                if (thinkingConfig.mode === "high") {
                    console.log("[THINK] Round 2: Critical rethink...");
                    const stripper2 = createThoughtTagStripper();
                    const rethinkPrompt =
                        "Please perform a second round of deep critical rethinking of the above (High reasoning mode required): check for better solutions, missing details, or potential errors, and output a more complete [[REASON]]...[[/REASON]] directly (no tool calls or 【TOOL_CALL】 in this round; stop immediately after [[/REASON]]).";

                    const rethinkRaw = await runSingleGeminiTurn({
                        promptText: rethinkPrompt,
                        files: [],
                        thinkingLevel,
                        onCleanDelta: (delta) => {
                            const cleanThought = stripper2.push(delta);
                            if (cleanThought) {
                                fullReasoningAccumulated += cleanThought;
                                emitReasoning(cleanThought);
                            }
                        },
                        abortState,
                    });
                    const rem2 = stripper2.flush();
                    if (rem2) {
                        fullReasoningAccumulated += rem2;
                        emitReasoning(rem2);
                    }

                    if (hasTools && parseToolCalls(rethinkRaw).toolCalls.length > 0) {
                        console.log("[THINK] Captured premature 【TOOL_CALL】 emitted in Round 2; skipping final execution turn.");
                        finalRawResponse = rethinkRaw;
                    }
                }

                // 4. Final Execution Turn (【TOOL_CALL】 or Final Answer + 【END_RESPONSE】)
                if (!finalRawResponse) {
                    console.log("[THINK] Executing final output turn...");
                    finalRawResponse = await runSingleGeminiTurn({
                        promptText: buildFinalExecutionPrompt(hasTools, toolSignatures, workspaceSkillsList),
                        files: [],
                        thinkingLevel,
                        onCleanDelta: streamDeltaHandler,
                        abortState,
                    });
                    if (ghostSession && activeTab?.id) ghostSession.tabId = activeTab.id;
                }
            }
        }
        if (abortState.aborted) return;
        execRouter.flush();

        // Strip all residual [[REASON]] and 【END_RESPONSE】 tags to prevent leaking into text
        let { textWithoutTags, hasEndResponse } = extractAndStripProtocolTags(finalRawResponse);
        let { toolCalls, cleanText } = parseToolCalls(textWithoutTags);

        // Post-Execution Audit loop:
        // If the model only output [[REASON]] in the execution turn (resulting in empty toolCalls and no 【END_RESPONSE】),
        // or has tools but did not call them nor confirm completion, retry up to 2 rounds until 【TOOL_CALL】 or 【END_RESPONSE】 is received
        let auditAttempt = 0;
        const maxAuditAttempts = 2;
        while (
            !abortState.aborted &&
            toolCalls.length === 0 &&
            !hasEndResponse &&
            (hasTools || !cleanText) &&
            auditAttempt < maxAuditAttempts
        ) {
            auditAttempt++;
            console.log(
                `[AUDIT] Attempt ${auditAttempt}/${maxAuditAttempts}: Missing 【TOOL_CALL】 and 【END_RESPONSE】 (cleanTextLen=${cleanText.length}); sending audit prompt...`,
            );

            const auditRouter = createExecutionStreamRouter({
                onReasoning: (thoughtDelta) => {
                    fullReasoningAccumulated += thoughtDelta;
                    emitReasoning(thoughtDelta);
                },
                onContent: (safeText) => emitContent(safeText),
            });

            const auditRaw = await runSingleGeminiTurn({
                promptText: hasTools
                    ? POST_EXECUTION_AUDIT_PROMPT
                    : "Do NOT output [[REASON]]. Provide your direct final answer to the user now, and end with 【END_RESPONSE】.",
                files: [],
                thinkingLevel,
                onCleanDelta: (delta) => auditRouter.push(delta),
                abortState,
            });
            auditRouter.flush();
            if (ghostSession && activeTab?.id) ghostSession.tabId = activeTab.id;

            const auditExtracted = extractAndStripProtocolTags(auditRaw);
            const auditParsed = parseToolCalls(auditExtracted.textWithoutTags);

            if (auditParsed.toolCalls.length > 0) {
                console.log(`[AUDIT] Recovered ${auditParsed.toolCalls.length} tool call(s) on audit attempt ${auditAttempt}.`);
                toolCalls = auditParsed.toolCalls;
                cleanText = auditParsed.cleanText;
                break;
            }
            if (auditExtracted.hasEndResponse) {
                console.log(`[AUDIT] Model confirmed completion with 【END_RESPONSE】 on attempt ${auditAttempt}.`);
                hasEndResponse = true;
                if (auditParsed.cleanText) cleanText = auditParsed.cleanText;
                break;
            }
            if (auditParsed.cleanText) {
                cleanText = auditParsed.cleanText;
            }
        }

        const hasToolCalls = toolCalls.length > 0;

        // Clean text was already streamed live via execRouter; only emit structured tool_calls here
        if (hasTools && effectiveStream && hasToolCalls) {
                if (protocol === "openai") {
                    for (let i = 0; i < toolCalls.length; i++) {
                        const tc = toolCalls[i];
                        const tcChunk = {
                            id: completionId,
                            object: "chat.completion.chunk",
                            created,
                            model,
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: i,
                                                id: tc.id,
                                                type: "function",
                                                function: {
                                                    name: tc.function.name,
                                                    arguments: tc.function.arguments,
                                                },
                                            },
                                        ],
                                    },
                                    logprobs: null,
                                    finish_reason: null,
                                },
                            ],
                        };
                        res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
                    }
                } else if (protocol === "ollama") {
                    const tcChunk = {
                        model,
                        created_at: new Date().toISOString(),
                        message: {
                            role: "assistant",
                            content: "",
                            tool_calls: toolCalls.map((tc) => ({
                                function: {
                                    name: tc.function.name,
                                    arguments: JSON.parse(tc.function.arguments || "{}"),
                                },
                            })),
                        },
                        done: false,
                    };
                    res.write(`${JSON.stringify(tcChunk)}\n`);
                } else if (protocol === "claude") {
                    if (claudeTextBlockStarted) {
                        res.write(
                            `event: content_block_stop\ndata: ${JSON.stringify({
                                type: "content_block_stop",
                                index: 0,
                            })}\n\n`,
                        );
                    }
                    const baseIdx = claudeTextBlockStarted ? 1 : 0;
                    for (let i = 0; i < toolCalls.length; i++) {
                        const tc = toolCalls[i];
                        const idx = baseIdx + i;
                        res.write(
                            `event: content_block_start\ndata: ${JSON.stringify({
                                type: "content_block_start",
                                index: idx,
                                content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} },
                            })}\n\n`,
                        );
                        res.write(
                            `event: content_block_delta\ndata: ${JSON.stringify({
                                type: "content_block_delta",
                                index: idx,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: tc.function.arguments,
                                },
                            })}\n\n`,
                        );
                        res.write(
                            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`,
                        );
                    }
                }
            }

        const reasoningTokens = await countGeminiTokensExact(fullReasoningAccumulated);
        const completionOnlyTokens = await countGeminiTokensExact(cleanText || "");
        const outputTokens = reasoningTokens + completionOnlyTokens;
        const totalDurationNs = Number(process.hrtime.bigint() - startTimeNs);

        // 5. Finish Stream or Send Non-Streaming JSON
        if (effectiveStream) {
            if (protocol === "ollama") {
                res.write(
                    `${JSON.stringify(
                        createOllamaChunk(model, "", true, isGenerate, {
                            totalDurationNs,
                            inputTokens,
                            outputTokens,
                        }),
                    )}\n`,
                );
            } else if (protocol === "claude") {
                if (claudeTextBlockStarted && !hasToolCalls) {
                    res.write(
                        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
                    );
                }
                res.write(
                    `event: message_delta\ndata: ${JSON.stringify({
                        type: "message_delta",
                        delta: {
                            stop_reason: hasToolCalls ? "tool_use" : "end_turn",
                            stop_sequence: null,
                        },
                        usage: { output_tokens: outputTokens },
                    })}\n\n`,
                );
                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            } else {
                const stopChunk = createOpenAIChunk(completionId, created, model, null, hasToolCalls ? "tool_calls" : "stop");
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

                const usageChunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [],
                    usage: {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens,
                        completion_tokens_details: {
                            reasoning_tokens: reasoningTokens,
                        },
                    },
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
            }
            console.log(
                `[CHAT] Finished stream protocol=${protocol} reasoningChars=${totalReasoningChars} outputChars=${totalOutputChars} toolCalls=${toolCalls.length}`,
            );
            res.end();
            return;
        }

        // Non-streaming JSON response
        if (protocol === "ollama") {
            return res.json({
                ...createOllamaChunk(model, cleanText, true, isGenerate, {
                    totalDurationNs,
                    inputTokens,
                    outputTokens,
                }),
                ...(hasToolCalls
                    ? {
                          message: {
                              role: "assistant",
                              content: cleanText,
                              tool_calls: toolCalls.map((tc) => ({
                                  function: {
                                      name: tc.function.name,
                                      arguments: JSON.parse(tc.function.arguments || "{}"),
                                  },
                              })),
                          },
                      }
                    : {}),
            });
        }
        if (protocol === "claude") {
            const contentBlocks = [];
            if (cleanText) contentBlocks.push({ type: "text", text: cleanText });
            for (const tc of toolCalls) {
                contentBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments || "{}"),
                });
            }
            return res.json({
                id: claudeMsgId,
                type: "message",
                role: "assistant",
                model,
                content: contentBlocks,
                stop_reason: hasToolCalls ? "tool_use" : "end_turn",
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                },
            });
        }
        res.json({
            id: completionId,
            object: "chat.completion",
            created,
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: hasToolCalls ? null : cleanText,
                        ...(fullReasoningAccumulated ? { reasoning_content: fullReasoningAccumulated } : {}),
                        ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
                    },
                    logprobs: null,
                    finish_reason: hasToolCalls ? "tool_calls" : "stop",
                },
            ],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
            },
        });
    } catch (err) {
        console.error("[CHAT] Execution error:", err.message);
        if (!res.writableEnded) {
            if (effectiveStream) {
                if (protocol === "ollama") {
                    res.write(`${JSON.stringify({ error: err.message, done: true })}\n`);
                } else if (protocol === "claude") {
                    res.write(
                        `event: error\ndata: ${JSON.stringify({
                            type: "error",
                            error: { type: "api_error", message: err.message },
                        })}\n\n`,
                    );
                } else {
                    res.write(
                        `data: ${JSON.stringify({
                            error: { message: err.message, type: "bridge_error" },
                        })}\n\n`,
                    );
                    res.write("data: [DONE]\n\n");
                }
                res.end();
            } else {
                res.status(502).json({
                    type: "error",
                    error: { message: err.message, type: "bridge_error" },
                });
            }
        }
    } finally {
        releaseBridgeLock();
        res.off("close", onClientAbort);
    }
}

app.listen(HTTP_PORT, () => {
    console.log(`[HTTP] OpenAI-compatible API listening on http://127.0.0.1:${HTTP_PORT}/v1`);
    console.log(`[TAB]  Waiting for the userscript to poll http://127.0.0.1:${HTTP_PORT}/bridge/...`);
});