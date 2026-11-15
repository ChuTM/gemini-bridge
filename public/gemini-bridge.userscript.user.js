// ==UserScript==
// @name         Gemini Web Bridge for Local Gateway
// @namespace    tampermonkey-gemini-bridge
// @version      1.4.0
// @description  Frame-accurate streaming bridge between Gemini Web UI and local gateway
// @match        https://gemini.google.com/*
// @match        https://gemini.google.com/u/*/app*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
	// Declared first: everything below uses them, and `const` has a temporal dead zone.
	const log = (...args) => console.log("[Gemini Web Bridge]", ...args);
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	const isTopFrame = window.top === window.self;
	log("Starts. version=1.6.0 (Menu Input Hook + Full Markdown) top=" + isTopFrame + " href=" + location.href);

	// Helper iframes (e.g. / _ /bscframe) also match @match; only the real page talks.
	if (!isTopFrame) {
		log("Ignoring sub-frame", location.href);
		return;
	}

	// ==========================================
	// DOM helpers (Gemini's class names are hashed; prefer roles/labels/text)
	// ==========================================
	// Hidden is fine as long as the element is in the DOM (Gemini hides the
	// composer for a moment while switching chats). We only reject detached nodes.
	const isAttached = (el) => !!el && el.isConnected;

	// Gemini's composer is a <rich-textarea>. The editor inside it is the
	// deepest contenteditable; other selectors are just fallbacks.
	const EDITOR_SELECTORS = [
		"rich-textarea .ql-editor[contenteditable]",
		"rich-textarea [contenteditable]",
		"rich-textarea textarea",
		"div[contenteditable='true'][role='textbox']",
		".text-input-field_textarea-wrapper [contenteditable='true']",
		"[aria-label*='Enter a prompt'][contenteditable='true']",
		"div.ql-editor[contenteditable]",
	];

	function pickBest(list, { requireVisible = false } = {}) {
		const usable = Array.from(list).filter((el) =>
			requireVisible
				? el.isConnected && el.getClientRects().length > 0
				: isAttached(el),
		);
		if (usable.length === 0) return null;
		// Deepest match: the editor itself, not its wrapper.
		const deepest = usable.filter(
			(el) => !usable.some((other) => other !== el && el.contains(other)),
		);
		const pool = deepest.length ? deepest : usable;
		// The composer lives at the bottom of the page.
		return pool.sort(
			(a, b) =>
				b.getBoundingClientRect().top - a.getBoundingClientRect().top,
		)[0];
	}

	// Re-checks up to `timeoutMs`: the composer may not be rendered yet, or may
	// be mid-rebuild after a chat switch.
	async function waitFor(fn, timeoutMs, intervalMs = 100) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const v = fn();
			if (v) return v;
			if (Date.now() > deadline) return null;
			await sleep(intervalMs);
		}
	}

	// Returns { editor, box }. `box` is the <rich-textarea> element or, failing
	// that, whatever contains the editor.
	function findEditor() {
		for (const sel of EDITOR_SELECTORS) {
			const editor = pickBest(document.querySelectorAll(sel));
			if (editor) {
				return {
					editor,
					box:
						editor.closest("rich-textarea") || editor.parentElement,
				};
			}
		}
		return null;
	}

	// Find the composer, retrying until the timeout. Used by every action.
	async function requireEditor(timeoutMs = 15000) {
		const found = await waitFor(findEditor, timeoutMs, 150);
		if (!found) throw new Error("rich-textarea not found after retrying");
		return found;
	}

	function findSendButton() {
		const btn = document.querySelector("button[aria-label='Send message']");
		if (!btn) return null;
		if (btn.disabled || btn.getAttribute("aria-disabled") === "true")
			return null;
		return btn;
	}

	function isButtonEnabled(btn) {
		if (!btn) return false;
		if (btn.disabled) return false;
		if (btn.getAttribute("aria-disabled") === "true") return false;
		return true;
	}

	function findStopButton() {
		return pickBest(
			document.querySelectorAll(
				'button[aria-label*="Stop" i], button[aria-label*="Cancel" i]',
			),
		);
	}

	// Sets the value of a native <textarea>/<input> through the prototype setter,
	// so the page's own value-tracking (Angular, Polymer) sees the change.
	function setNativeValue(el, text) {
		const proto =
			el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		if (setter) setter.call(el, text);
		else el.value = text;
	}

	// Inserts text at the caret via the editing command, falling back to a
	// manual range insert when execCommand is unavailable or refuses.
	function insertText(chunk) {
		try {
			if (document.execCommand("insertText", false, chunk)) return;
		} catch (_) {}
		const sel = window.getSelection();
		if (!sel.rangeCount) return;
		const range = sel.getRangeAt(0);
		const node = document.createTextNode(chunk);
		range.deleteContents();
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	// Types the text through real `beforeinput`/`input` events. Gemini's Angular
	// layer reacts to those; a bare DOM mutation leaves its model empty, which
	// keeps the send button disabled even though the text looks present.
	function typeIntoEditor(editor, text) {
		const sel = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(editor);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);

		const fire = (type, data) => {
			editor.dispatchEvent(
				new InputEvent(type, {
					bubbles: true,
					cancelable: type === "beforeinput",
					composed: true,
					inputType: "insertText",
					data,
				}),
			);
		};

		const rows = text.split("\n");
		rows.forEach((line, i) => {
			if (line) {
				fire("beforeinput", line);
				insertText(line);
				fire("input", line);
			}
			if (i < rows.length - 1) {
				insertText("\n");
			}
		});
	}

	// Fills the composer so Gemini's own model has the text and the send button
	// becomes enabled. Never uses innerHTML: the page enforces Trusted Types,
	// which rejects string assignment.
	function writeEditor(editor, text) {
		editor.focus();

		if (
			editor instanceof HTMLTextAreaElement ||
			editor instanceof HTMLInputElement
		) {
			setNativeValue(editor, text);
		} else {
			typeIntoEditor(editor, text);
		}

		editor.dispatchEvent(
			new InputEvent("input", {
				bubbles: true,
				composed: true,
				data: text,
				inputType: "insertText",
			}),
		);
		editor.dispatchEvent(new Event("change", { bubbles: true }));
	}

	// ==========================================
	// Transport: long-polling over GM_xmlhttpRequest.
	// Gemini's CSP blocks ws://127.0.0.1, but GM_xmlhttpRequest runs in the
	// extension's own privileged context and is not subject to page CSP.
	// ==========================================
	const BASE = "http://127.0.0.1:3000";
	const TAB_ID =
		Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

	let bridgeEnabled = false;
	let connected = false;
	let pollDelay = 1000;
	let pollCount = 0;
	let pollTimer = null;

	// ==========================================
	// Floating activation button (Trusted Types safe: no innerHTML)
	// ==========================================
	let uiBtn = null;
	let uiDot = null;
	let uiLabel = null;

	function updateButtonUI(state) {
		if (!uiBtn || !uiDot || !uiLabel) return;
		if (state === "connected") {
			uiBtn.style.background = "#0f291e";
			uiBtn.style.borderColor = "#34d399";
			uiBtn.style.color = "#d1fae5";
			uiDot.style.background = "#34d399";
			uiLabel.textContent = "Bridge active (Click to disconnect)";
		} else if (state === "connecting") {
			uiBtn.style.background = "#292111";
			uiBtn.style.borderColor = "#fbbf24";
			uiBtn.style.color = "#fef3c7";
			uiDot.style.background = "#fbbf24";
			uiLabel.textContent = "Connecting to bridge...";
		} else if (state === "error") {
			uiBtn.style.background = "#2b1414";
			uiBtn.style.borderColor = "#f87171";
			uiBtn.style.color = "#fee2e2";
			uiDot.style.background = "#f87171";
			uiLabel.textContent = "Gateway offline (Retrying...)";
		} else {
			uiBtn.style.background = "#1e1f20";
			uiBtn.style.borderColor = "rgba(255, 255, 255, 0.2)";
			uiBtn.style.color = "#e3e3e3";
			uiDot.style.background = "#9aa0a6";
			uiLabel.textContent = "Use this tab as bridge";
		}
	}

	const SESSION_BRIDGE_KEY = "gemini_web_bridge_active";

	function startBridge() {
		if (bridgeEnabled) return;
		bridgeEnabled = true;
		connected = false;
		pollDelay = 1000;
		pollCount = 0;
		try {
			sessionStorage.setItem(SESSION_BRIDGE_KEY, "1");
		} catch (_) {}
		updateButtonUI("connecting");
		log("Starting bridge on this tab...");
		poll(true);
	}

	function stopBridge(notifyServer = true) {
		try {
			sessionStorage.removeItem(SESSION_BRIDGE_KEY);
		} catch (_) {}
		if (!bridgeEnabled && !connected) {
			updateButtonUI("idle");
			return;
		}
		bridgeEnabled = false;
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (streamInterval) {
			clearInterval(streamInterval);
			streamInterval = null;
		}
		if (notifyServer && connected) {
			send({ behaviour: "disconnect" }, true);
		}
		connected = false;
		updateButtonUI("idle");
		log("Bridge disconnected on this tab.");
	}

	function injectBridgeButton() {
		if (document.getElementById("gemini-web-bridge-btn")) return;
		if (!document.body) return;

		uiBtn = document.createElement("button");
		uiBtn.id = "gemini-web-bridge-btn";
		uiBtn.type = "button";
		Object.assign(uiBtn.style, {
			position: "fixed",
			bottom: "16px",
			right: "16px",
			zIndex: "999999",
			display: "inline-flex",
			alignItems: "center",
			gap: "8px",
			padding: "8px 14px",
			borderRadius: "999px",
			border: "1px solid rgba(255, 255, 255, 0.2)",
			background: "#1e1f20",
			color: "#e3e3e3",
			fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
			fontSize: "12px",
			fontWeight: "500",
			lineHeight: "1",
			cursor: "pointer",
			boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
			transition: "all 0.15s ease",
		});

		uiDot = document.createElement("span");
		Object.assign(uiDot.style, {
			width: "8px",
			height: "8px",
			borderRadius: "50%",
			background: "#9aa0a6",
			flexShrink: "0",
		});

		uiLabel = document.createElement("span");
		uiLabel.textContent = "Use this tab as bridge";

		uiBtn.appendChild(uiDot);
		uiBtn.appendChild(uiLabel);

		uiBtn.addEventListener("click", () => {
			if (bridgeEnabled) {
				stopBridge(true);
			} else {
				startBridge();
			}
		});

		document.body.appendChild(uiBtn);
	}

	function send(body, force = false, retries = 2) {
		if (!bridgeEnabled && !force) return;
		const isCritical = ["message_completed", "error", "ack"].includes(body.behaviour);
		GM_xmlhttpRequest({
			method: "POST",
			url: `${BASE}/bridge/message`,
			headers: { "Content-Type": "application/json" },
			timeout: 8000,
			data: JSON.stringify({ ...body, href: location.href, tabId: TAB_ID }),
			onerror: (e) => {
				log(
					"POST /bridge/message failed:",
					body.behaviour,
					e?.error || e?.statusText || "network error",
				);
				if (isCritical && retries > 0) {
					setTimeout(() => send(body, force, retries - 1), 400);
				}
			},
			ontimeout: () => {
				if (isCritical && retries > 0) {
					setTimeout(() => send(body, force, retries - 1), 400);
				}
			},
		});
	}

	function schedulePoll(delayMs) {
		if (!bridgeEnabled) return;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => poll(false), delayMs);
	}

	function poll(claim = false) {
		if (!bridgeEnabled) return;
		const q = new URLSearchParams({
			tab: TAB_ID,
			href: location.href,
			top: isTopFrame ? "1" : "0",
			...(claim ? { claim: "1" } : {}),
		});
		GM_xmlhttpRequest({
			method: "GET",
			url: `${BASE}/bridge/poll?${q}`,
			timeout: 5000,
			onload: (res) => {
				if (!bridgeEnabled) return;
				pollCount++;
				if (pollCount === 1) {
					log(
						`First poll answered: HTTP ${res.status} top=${isTopFrame} tabId=${TAB_ID}`,
					);
				}
				if (!connected) {
					connected = true;
					pollDelay = 1000;
					updateButtonUI("connected");
					log("Connected to local gateway");
					send({
						behaviour: "report_existence",
						href: location.href,
						isTop: isTopFrame,
					});
				}
				if (res.status === 200) {
					let payload = null;
					try {
						payload = JSON.parse(res.responseText);
					} catch (e) {
						log(
							"Bad poll payload:",
							res.responseText?.slice(0, 200),
							e,
						);
					}
					if (payload?.replaced) {
						log("Another tab claimed the bridge; stopping this tab.");
						stopBridge(false);
						return;
					}
					const commands = payload?.commands || [];
					if (commands.length) {
						log(
							"Received commands:",
							commands
								.map((c) => `${c.command}#${c.id}`)
								.join(", "),
						);
					}
					schedulePoll(200);
					Promise.all(commands.map(runCommand));
					return;
				}
				if (res.status !== 204)
					log(`Poll returned HTTP ${res.status} (expected 200/204)`);
				schedulePoll(100);
			},
			onerror: (e) => {
				if (!bridgeEnabled) return;
				if (connected) log("Lost the local gateway, retrying…");
				else if (pollCount === 0)
					log(
						"Cannot reach http://127.0.0.1:3000 — is `node server.js` running?",
					);
				connected = false;
				updateButtonUI("error");
				pollDelay = Math.min(pollDelay * 2, 15000);
				log(
					"Poll error:",
					e?.error || "network error",
					`retry in ${pollDelay}ms`,
				);
				schedulePoll(pollDelay);
			},
			ontimeout: () => {
				if (!bridgeEnabled) return;
				log("Poll timed out, retrying");
				connected = false;
				updateButtonUI("error");
				schedulePoll(pollDelay);
			},
		});
	}

	async function openUrl(targetUrl, actionId) {
		const m = String(targetUrl || "").match(/\/app\/([a-zA-Z0-9_-]+)/);
		const appId = m ? m[1] : null;

		if (appId && location.href.includes(appId)) {
			send({ behaviour: "ack", id: actionId });
			return;
		}

		// Try SPA sidebar link click first (zero page reload)
		if (appId) {
			const link = document.querySelector(`a[href*="${appId}"]`);
			if (link) {
				link.click();
				const switched = await waitFor(
					() => (location.href.includes(appId) ? true : null),
					4000,
					50,
				);
				if (switched) {
					await waitFor(findEditor, 10000, 100);
					await sleep(150);
					send({ behaviour: "ack", id: actionId });
					return;
				}
			}
		}

		// Fallback: full navigation (sessionStorage keeps bridge active automatically after reload)
		send({ behaviour: "ack", id: actionId });
		await sleep(60);
		window.location.href = targetUrl;
	}

	async function runCommand(data) {
		if (!data || data.behaviour !== "gemini_action") return;
		try {
			switch (data.command) {
				case "prompt":
					await prompt_(data.text);
					break;
				case "add_file":
					await addFile(
						data.fileName,
						data.content,
						data.mimeType || "text/plain",
						Boolean(data.isBase64),
					);
					break;
				case "start_completion":
					await clickSendAndVerify();
					break;
				case "stop_response":
					stop();
					break;
				case "new_chat":
				case "ghost_chat":
					await newChat();
					break;
				case "open_url":
					await openUrl(data.url, data.id);
					return;
				default:
					log("Unknown command:", data.command);
					return;
			}
			log(`OK: ${data.command}`);
			send({ behaviour: "ack", id: data.id });
		} catch (err) {
			console.error("[Gemini Web Bridge] Action failed:", err);
			send({
				behaviour: "error",
				command: data.command,
				id: data.id,
				message: err.message,
			});
		}
	}

	// ==========================================
	// 1. Prompt
	// ==========================================
	async function prompt_(text) {
		const { editor } = await requireEditor();
		writeEditor(editor, text);
	}

	// ==========================================
	// ==========================================
	// 2. File attachment (Universal Paste -> Dual-Hook Menu -> Async Drag&Drop)
	// ==========================================
	function inferMimeType(fileName, fallback = "text/plain") {
		const ext = String(fileName || "").split(".").pop()?.toLowerCase();
		if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
		if (ext === "png") return "image/png";
		if (ext === "webp") return "image/webp";
		if (ext === "gif") return "image/gif";
		return fallback;
	}

	function countComposerAttachments() {
		const container =
			document.querySelector("rich-textarea")?.closest("form, .input-area-container, .text-input-field") ||
			document.body;
		return container.querySelectorAll(
			'uploader-file-preview, [data-test-id*="attachment"], [data-test-id*="file-preview"], .attachment-preview, .file-preview, .file-preview-container, .file-chip, mat-chip-row, rich-textarea img, .input-area img, button[aria-label*="Remove file" i], button[aria-label*="移除檔案" i], button[aria-label*="移除文件" i]',
		).length;
	}

	function hasActiveUploadSpinner() {
		const container =
			document.querySelector("rich-textarea")?.closest("form, .input-area-container, .text-input-field") ||
			document.body;
		return Boolean(
			container.querySelector(
				'mat-progress-bar, mat-progress-spinner, [role="progressbar"], [aria-busy="true"], .upload-spinner, .loading-spinner',
			),
		);
	}

	async function waitForAttachmentUploadComplete(beforeCount, isImage) {
		await waitFor(
			() => (countComposerAttachments() > beforeCount ? true : null),
			8000,
			100,
		);
		await sleep(isImage ? 800 : 350);
		await waitFor(() => (!hasActiveUploadSpinner() ? true : null), 20000, 150);
		await waitFor(() => (findSendButton() ? true : null), 15000, 150);
		await sleep(isImage ? 600 : 250);
	}

	function findPlusMenuButton() {
		const selectors = [
			'button[aria-label*="Add files" i]',
			'button[aria-label*="Upload" i]',
			'button[aria-label*="Attach" i]',
			'button[aria-label*="Open upload" i]',
			'button[aria-label*="新增" i]',
			'button[aria-label*="上傳" i]',
			'button[aria-label*="上传" i]',
			'button[aria-label*="添加" i]',
		];
		for (const sel of selectors) {
			const btn = pickBest(document.querySelectorAll(sel), { requireVisible: true });
			if (btn) return btn;
		}
		// Fallback: find "+" or paperclip icon button in bottom composer area
		const composer = document.querySelector("rich-textarea")?.closest("form, .input-area-container, .text-input-field, div");
		if (composer) {
			const btns = Array.from(composer.querySelectorAll("button")).filter(
				(b) => b.isConnected && b.getClientRects().length > 0,
			);
			for (const b of btns) {
				const icon = b.querySelector("mat-icon");
				const iconName = (
					icon?.getAttribute("fonticon") ||
					icon?.getAttribute("data-mat-icon-name") ||
					icon?.textContent ||
					""
				)
					.trim()
					.toLowerCase();
				if (iconName === "add" || iconName === "attach_file" || iconName === "add_circle") {
					return b;
				}
			}
		}
		return null;
	}

	function closeOverlayMenus() {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }),
		);
		const backdrop = document.querySelector(".cdk-overlay-backdrop");
		if (backdrop && typeof backdrop.click === "function") {
			backdrop.click();
		}
	}

	async function triggerUploadMenuAndGetInput() {
		// Wait for "+" button to be ready (composer may be re-rendering right after switching to Temporary Chat)
		const plusBtn = await waitFor(findPlusMenuButton, 4000, 100);
		if (!plusBtn) return null;

		plusBtn.click();
		await sleep(300);

		let input = document.querySelector('input[type="file"]');
		if (input) return input;

		// Wait for "Upload file / Upload from computer" menu item to expand
		const menuItem = await waitFor(() => {
			const items = Array.from(
				document.querySelectorAll(
					'[role="menuitem"], .mat-mdc-menu-item, button[data-test-id*="upload" i], button[data-test-id*="local" i]',
				),
			).filter((el) => el.isConnected && el.getClientRects().length > 0);
			if (items.length === 0) return null;

			const uploadMatch = items.find((el) => {
				const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`;
				if (/drive|雲端|云端|photo|相簿|相册|code|程式碼|代码/i.test(label)) return false;
				return /upload|local|computer|file|裝置|電腦|上傳|档案|檔案|上传|本地|文件/i.test(label);
			});
			return uploadMatch || items[0];
		}, 3500, 80);

		if (!menuItem) {
			closeOverlayMenus();
			return null;
		}

		// Dual Hook: simultaneously intercept dynamically created <input type="file"> and .click(), kept valid throughout the wait window
		let capturedInput = null;
		const origClick = HTMLInputElement.prototype.click;
		const origCreateElement = document.createElement.bind(document);

		document.createElement = function (tagName, options) {
			const el = origCreateElement(tagName, options);
			if (String(tagName).toLowerCase() === "input") {
				queueMicrotask(() => {
					if (el.type === "file") capturedInput = el;
				});
			}
			return el;
		};

		HTMLInputElement.prototype.click = function () {
			if (this.type === "file") {
				capturedInput = this;
				return;
			}
			return origClick.apply(this, arguments);
		};

		try {
			menuItem.click();
			await waitFor(
				() => capturedInput || document.querySelector('input[type="file"]'),
				3000,
				50,
			);
		} finally {
			HTMLInputElement.prototype.click = origClick;
			document.createElement = origCreateElement;
		}

		return capturedInput || document.querySelector('input[type="file"]');
	}

	async function addFile(fileName, content, mimeType = "text/plain", isBase64 = false) {
		const resolvedMime =
			mimeType && mimeType !== "text/plain"
				? mimeType
				: inferMimeType(fileName, "text/plain");
		const isImage = resolvedMime.startsWith("image/");
		const shouldDecodeBase64 =
			Boolean(isBase64) || isImage || /^data:[^;]+;base64,/.test(String(content || ""));

		let filePayload = content;
		if (shouldDecodeBase64) {
			const cleanB64 = String(content)
				.replace(/^data:[^;]+;base64,/, "")
				.replace(/\s+/g, "");
			const binStr = atob(cleanB64);
			const bytes = new Uint8Array(binStr.length);
			for (let i = 0; i < binStr.length; i++) {
				bytes[i] = binStr.charCodeAt(i);
			}
			filePayload = bytes;
		}
		const file = new File([filePayload], fileName, { type: resolvedMime });
		const dt = new DataTransfer();
		dt.items.add(file);

		const beforeCount = countComposerAttachments();
		const { editor, box } = await requireEditor();

		// Strategy A: All files (including workspace_spec.txt and images) first attempt simulated clipboard paste, no need to open menu
		editor.focus();
		const pasteEvt = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			composed: true,
			clipboardData: dt,
		});
		editor.dispatchEvent(pasteEvt);

		const pasted = await waitFor(
			() => (countComposerAttachments() > beforeCount ? true : null),
			isImage ? 2500 : 1200,
			100,
		);
		if (pasted) {
			await waitForAttachmentUploadComplete(beforeCount, isImage);
			log(`File attached via paste: ${fileName}`);
			return;
		}

		// Strategy B: Trigger via "+" menu and capture in-memory <input type="file"> with Dual Hook
		let input = document.querySelector('input[type="file"]');
		if (!input) {
			input = await triggerUploadMenuAndGetInput();
		}

		if (input) {
			try {
				input.value = "";
			} catch (_) {}
			Object.defineProperty(input, "files", {
				configurable: true,
				get: () => dt.files,
			});
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await waitForAttachmentUploadComplete(beforeCount, isImage);
			closeOverlayMenus();
			log(`File attached via input: ${fileName}`);
			return;
		}

		// Strategy C: Simulate real drag-and-drop in two stages (trigger dragenter to let Gemini render Dropzone, wait 150ms then drop)
		const dropTarget =
			box?.closest(".input-area-container, form, .text-input-field") || box || editor;
		for (const target of [document.body, dropTarget]) {
			target.dispatchEvent(
				new DragEvent("dragenter", {
					bubbles: true,
					cancelable: true,
					composed: true,
					dataTransfer: dt,
				}),
			);
			target.dispatchEvent(
				new DragEvent("dragover", {
					bubbles: true,
					cancelable: true,
					composed: true,
					dataTransfer: dt,
				}),
			);
		}
		await sleep(150);
		dropTarget.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				composed: true,
				dataTransfer: dt,
			}),
		);

		const dropped = await waitFor(
			() => (countComposerAttachments() > beforeCount ? true : null),
			4000,
			100,
		);
		if (dropped) {
			await waitForAttachmentUploadComplete(beforeCount, isImage);
			log(`File attached via drop: ${fileName}`);
			return;
		}

		throw new Error("File input not found after paste, menu, and drop fallbacks");
	}

	// ==========================================
	// 3. Send
	// ==========================================
	async function clickSendAndVerify() {
		const initialCount = document.querySelectorAll("model-response").length;
		const found = findEditor();
		const editor = found?.editor || found;
		if (editor && typeof editor.focus === "function") {
			editor.focus();
			editor.dispatchEvent(new Event("input", { bubbles: true }));
			editor.dispatchEvent(new Event("change", { bubbles: true }));
		}

		// Wait up to 4s for Send button to become enabled
		const enableDeadline = Date.now() + 4000;
		let sendBtn = null;
		while (Date.now() < enableDeadline) {
			const candidate = findSendButton();
			if (isButtonEnabled(candidate)) {
				sendBtn = candidate;
				break;
			}
			await sleep(80);
		}

		if (!sendBtn) {
			throw new Error("Send button never became enabled");
		}

		// Click and verify editor clears (up to 2 quick retries)
		for (let attempt = 0; attempt < 2; attempt++) {
			sendBtn = findSendButton() || sendBtn;
			sendBtn.click();
			await sleep(250);

			const currentEditorRaw = findEditor();
			const currentEditor = currentEditorRaw?.editor || currentEditorRaw;
			const remainingText = (currentEditor?.innerText || currentEditor?.textContent || "").trim();
			if (!remainingText || document.querySelector("button[aria-label*='Stop' i], button[aria-label*='停止' i]")) {
				checkStream(initialCount);
				return;
			}
		}

		// Fallback: press Enter inside the editor
		const fallbackRaw = findEditor();
		const fallbackEditor = fallbackRaw?.editor || fallbackRaw;
		if (fallbackEditor && typeof fallbackEditor.focus === "function") {
			fallbackEditor.focus();
			fallbackEditor.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
			);
		}
		checkStream(initialCount);
	}

	// ==========================================
	// 4. Stop
	// ==========================================
	function stop() {
		const btn = findStopButton();
		if (btn) btn.click();
	}

	// ==========================================
	// 5. New Ghost Chat (Strictly enforce Temporary Chat on every new_chat)
	// ==========================================
	function isVisibleEl(el) {
		if (!el || !el.isConnected) return false;
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
			return false;
		}
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	// Check if Temporary Chat is active (do NOT require visibility, because Gemini auto-collapses the sidebar after entering)
	function isTempChatActive() {
		// 1. Direct check for the active toggle state: aria-label="Turn off temporary chat"
		const turnOffBtn = document.querySelector(
			'button[aria-label*="Turn off temporary chat" i], a[aria-label*="Turn off temporary chat" i], ' +
			'button[aria-label*="關閉臨時對話" i], button[aria-label*="关闭临时对话" i]',
		);
		if (turnOffBtn && turnOffBtn.isConnected) {
			return true;
		}

		// 2. Fallback check on page disclaimer text
		const bodyText = document.body ? document.body.innerText || "" : "";
		if (
			/aren['’]t used to improve our models/i.test(bodyText) ||
			/不會用於改善我們的模型|不会用于改进我们的模型/.test(bodyText)
		) {
			return true;
		}

		return false;
	}

	function findTurnOnTempChatButton() {
		// 1. Match explicit "Turn on temporary chat" aria-label (even if sidebar is collapsed, click works if connected; prefer visible)
		const labelSelectors = [
			'button[aria-label*="Turn on temporary chat" i]',
			'a[aria-label*="Turn on temporary chat" i]',
			'button[aria-label*="開啟臨時對話" i]',
			'button[aria-label*="开启临时对话" i]',
		];
		for (const sel of labelSelectors) {
			const all = Array.from(document.querySelectorAll(sel)).filter((el) => el.isConnected);
			const visible = all.find(isVisibleEl);
			if (visible) return visible;
			if (all.length > 0) return all[0];
		}

		// 2. Fallback to Gemini's inactive mat-icon name: fonticon="gemini_chat_temp"
		const buttons = Array.from(document.querySelectorAll("button, a")).filter((el) => el.isConnected);
		for (const el of buttons) {
			const icon = el.querySelector("mat-icon");
			const iconName = (
				icon?.getAttribute("fonticon") ||
				icon?.getAttribute("data-mat-icon-name") ||
				icon?.textContent ||
				""
			)
				.trim()
				.toLowerCase();
			if (iconName === "gemini_chat_temp" || iconName === "temp_chat") {
				return el;
			}
		}

		return null;
	}

	function findSidebarMenuButton() {
		const menuSelectors = [
			'button[data-test-id="side-nav-menu-button"]',
			'button[aria-label*="Main menu" i]',
			'button[aria-label*="Expand menu" i]',
			'button[aria-label*="主選單" i]',
			'button[aria-label*="展開選單" i]',
			'button[aria-label*="主菜单" i]',
			'button[aria-label*="展开菜单" i]',
		];
		for (const sel of menuSelectors) {
			const btn = Array.from(document.querySelectorAll(sel)).find(isVisibleEl);
			if (btn) return btn;
		}
		return null;
	}

	function findStandardNewChatButton() {
		const fallbackSelector =
			'button[data-test-id="new-chat-button"], ' +
			'button[aria-label*="New chat" i], a[aria-label*="New chat" i], ' +
			'button[aria-label*="New conversation" i], ' +
			'button[aria-label*="發起新對話" i], button[aria-label*="发起新对话" i]';
		const all = Array.from(document.querySelectorAll(fallbackSelector)).filter((el) => el.isConnected);
		return all.find(isVisibleEl) || all[0] || null;
	}

	async function waitForTurnOnTempChatButton(timeoutMs = 8000) {
		const deadline = Date.now() + timeoutMs;
		let lastMenuClickAt = 0;
		let menuClicks = 0;

		while (Date.now() < deadline) {
			if (isTempChatActive()) return null;
			const btn = findTurnOnTempChatButton();
			if (btn) return btn;

			// Expand collapsed sidebar (throttled so we never toggle it closed)
			if (menuClicks < 2 && Date.now() - lastMenuClickAt > 1500) {
				const menuBtn = findSidebarMenuButton();
				if (menuBtn) {
					menuBtn.click();
					lastMenuClickAt = Date.now();
					menuClicks++;
				}
			}
			await sleep(250);
		}
		return null;
	}

	async function newChat() {
		// Step 1: Already in an EMPTY Temporary Chat -> ready immediately!
		if (isTempChatActive() && document.querySelectorAll("model-response, user-query").length === 0) {
			await waitFor(findEditor, 10000, 100);
			return;
		}

		// Step 2: Currently inside a Temporary Chat WITH old messages -> click "New chat" to clear it
		if (isTempChatActive()) {
			let resetBtn = findStandardNewChatButton();
			if (!resetBtn) {
				const menuBtn = findSidebarMenuButton();
				if (menuBtn) {
					menuBtn.click();
					await sleep(400);
					resetBtn = findStandardNewChatButton();
				}
			}
			if (resetBtn) {
				resetBtn.click();
				const cleared = await waitFor(
					() => (document.querySelectorAll("model-response, user-query").length === 0 ? true : null),
					3000,
					100,
				);
				// If old messages remain, click /app link to force back to blank new chat
				if (!cleared) {
					const appLink = document.querySelector('a[href="/app"], a[href*="/app?"]');
					if (appLink) {
						appLink.click();
						await waitFor(
							() => (document.querySelectorAll("model-response, user-query").length === 0 ? true : null),
							4000,
							100,
						);
					}
				}
				await sleep(350);
			}
		}

		// Step 3: Enter Temporary Chat (retry up to 3 attempts until isTempChatActive() is confirmed true)
		for (let attempt = 1; attempt <= 3; attempt++) {
			if (isTempChatActive()) break;

			const tempBtn = await waitForTurnOnTempChatButton(8000);
			if (isTempChatActive()) break;

			if (!tempBtn) {
				throw new Error("Turn on temporary chat button not found after 8s polling");
			}

			tempBtn.click();
			const entered = await waitFor(() => (isTempChatActive() ? true : null), 3500, 150);
			if (entered) break;
			log(`Temporary chat click attempt ${attempt} did not activate yet, retrying...`);
		}

		if (!isTempChatActive()) {
			throw new Error("Failed to enter Temporary Chat mode after 3 attempts");
		}

		await waitFor(
			() => (document.querySelectorAll("model-response, user-query").length === 0 ? true : null),
			4000,
			50,
		);
		await waitFor(findEditor, 10000, 100);
		await sleep(250);
	}
	// ==========================================
	// 6. Response streaming (HTML DOM -> Clean Markdown serializer)
	// ==========================================
	let streamInterval = null;

	const GEMINI_SYSTEM_ERRORS = [
		"I'm having a hard time fulfilling your request",
		"I encountered an error doing what you asked",
		"Sorry, something went wrong",
		"Something went wrong",
		"Something went wrong (1095)",
		"(1095)",
		"Rate limit",
		"rate limit",
		"An error occurred",
		"There was a problem generating a response",
		"Error generating response",
		"Unable to reach",
		"Network error",
		"You're offline",
		"網路錯誤",
		"網絡錯誤",
		"發生錯誤",
		"发生错误",
	];

	const IGNORED_TAGS = new Set([
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"SVG",
		"MAT-ICON",
		"BUTTON",
		"SOURCE-FOOTNOTE",
		"SOURCES-CAROUSEL",
		"RESPONSE-ELEMENT-FOOTER",
		"MESSAGE-ACTIONS",
		"MODEL-THOUGHTS",
		"CODE-EXECUTION",
		"TOOL-CALL",
		"TOOL-RESULT",
	]);

	function isIgnoredNode(el) {
		if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
		if (IGNORED_TAGS.has(el.tagName)) return true;
		if (el.getAttribute("aria-hidden") === "true") return true;
		const cls = typeof el.className === "string" ? el.className : "";
		const testId = el.getAttribute("data-test-id") || "";
		if (
			/citation|footnote|source-chip|attachment-chip|code-block-decoration|language-label|copy-button|code-block-header|tool-status|execution-status|thinking-indicator/i.test(cls) ||
			/citation|footnote|tool|thought/i.test(testId)
		) {
			return true;
		}
		// Filter out Gemini's inline image badge pills (e.g. "image_83b0a8c1.jpg" or "image_83b0a8c1.jpg + 1")
		if (
			el.tagName === "SPAN" &&
			el.children.length === 0 &&
			/^image_[a-z0-9_-]+\.(jpg|jpeg|png|webp|gif)(\s*\+\s*\d+)?$/i.test(
				(el.textContent || "").trim(),
			)
		) {
			return true;
		}
		return false;
	}

	function isBlockDisplay(el) {
		try {
			const display = window.getComputedStyle(el).display || "";
			return /^(block|flex|grid|table|list-item|flow-root)/.test(display);
		} catch (_) {
			return true;
		}
	}

	function serializeTable(tableEl) {
		const rows = Array.from(tableEl.querySelectorAll("tr"));
		if (rows.length === 0) return "";
		const matrix = rows.map((tr) =>
			Array.from(tr.querySelectorAll("th, td")).map((cell) =>
				serializeChildren(cell, false).replace(/\n+/g, " ").trim(),
			),
		);
		const colCount = Math.max(...matrix.map((r) => r.length));
		if (colCount === 0) return "";
		const padRow = (r) =>
			"| " +
			Array.from({ length: colCount }, (_, i) => (r[i] || "").replace(/\|/g, "\\|")).join(" | ") +
			" |";
		const header = padRow(matrix[0]);
		const sep = "| " + Array.from({ length: colCount }, () => "---").join(" | ") + " |";
		const body = matrix.slice(1).map(padRow);
		return `\n${[header, sep, ...body].join("\n")}\n\n`;
	}

	const CODE_HEADER_NOISE_RE =
		/^(代码块|程式碼片段|程式碼|代码|code\s*snippet|code|copy(\s*code)?|复制(代码)?|複製(程式碼)?)$/i;

	// 識別 Gemini 原生程式碼區塊容器（兼容 <code-block>、<pre> 以及新版帶雜湊 class 的卡片容器）
	function isCodeBlockContainer(el) {
		if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
		const tag = el.tagName;
		if (tag === "CODE-BLOCK" || tag === "PRE") return true;

		// 若容器內有 <code> 或 <pre>，且不包含段落/標題/列表（避免誤判整則回覆容器）
		const codeEl = el.querySelector("pre, code");
		if (!codeEl) return false;
		if (el.querySelector("p, ul, ol, h1, h2, h3, h4, h5, h6, table, blockquote")) {
			return false;
		}
		// 確認具有程式碼區塊特徵（複製按鈕或「代码块 / Code snippet」標頭）
		const hasCopyBtn = Boolean(
			el.querySelector(
				'button[aria-label*="Copy" i], button[aria-label*="复制" i], button[aria-label*="複製" i], button[mattooltip*="Copy" i]',
			),
		);
		const firstLine = (el.textContent || "").trim().split("\n")[0]?.trim() || "";
		return hasCopyBtn || CODE_HEADER_NOISE_RE.test(firstLine);
	}

	function extractCodeFromContainer(container) {
		const codeEl = container.querySelector("pre code, pre, code") || container;

		// 1. 提取語言標籤（從 class 或標頭文字提取，並過濾「代码块 / Copy」等 UI 雜訊）
		let lang = "";
		const classLang = (codeEl.className || "").match(/language-([a-zA-Z0-9_+-]+)/);
		if (classLang) {
			lang = classLang[1].toLowerCase();
		} else {
			const headerClone = container.cloneNode(true);
			headerClone.querySelectorAll("pre, code, button, mat-icon, svg").forEach((n) => n.remove());
			const tokens = (headerClone.textContent || "")
				.split(/[\r\n\t]+/)
				.map((s) => s.trim())
				.filter((s) => s && !CODE_HEADER_NOISE_RE.test(s) && s.length <= 24);
			if (tokens.length > 0 && /^[a-zA-Z0-9_+#.-]+$/.test(tokens[0])) {
				lang = tokens[0].toLowerCase();
			}
		}

		// 2. 完整保留換行與縮排提取程式碼內容（即使 Gemini 把每行包在 <div> 或 <span> 內也不會黏在一起）
		function readRawCode(node) {
			if (!node) return "";
			if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
			if (node.nodeType !== Node.ELEMENT_NODE) return "";
			if (isIgnoredNode(node)) return "";
			if (node.tagName === "BR") return "\n";

			let out = "";
			for (const child of node.childNodes) {
				out += readRawCode(child);
			}
			if (node !== codeEl && /^(DIV|P|LI)$/.test(node.tagName) && !out.endsWith("\n")) {
				out += "\n";
			}
			return out;
		}

		const codeText = readRawCode(codeEl).replace(/^\n+|\n+$/g, "");
		return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
	}

	function serializeChildren(node, inPre = false) {
		let out = "";
		for (const child of node.childNodes) {
			out += serializeNode(child, inPre);
		}
		return out;
	}

	function serializeNode(node, inPre = false) {
		if (!node) return "";
		if (node.nodeType === Node.TEXT_NODE) {
			const raw = node.nodeValue || "";
			if (inPre) return raw;
			// 關鍵：完整保留文字節點內的真實換行 \n（確保 ··· 程式碼區塊逐行換行），僅壓縮同一行內多餘空格
			return raw.replace(/\r\n?/g, "\n").replace(/[^\S\n]{2,}/g, " ");
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return "";
		if (isIgnoredNode(node)) return "";

		if (!inPre && isCodeBlockContainer(node)) {
			return extractCodeFromContainer(node);
		}

		const tag = node.tagName;

		if (tag === "BR") return inPre ? "\n" : "  \n";
		if (tag === "HR") return "\n---\n\n";

		if (/^H[1-6]$/.test(tag)) {
			const level = Number(tag[1]);
			const text = serializeChildren(node, false).trim();
			return text ? `${"#".repeat(level)} ${text}\n\n` : "";
		}

		if (tag === "P") {
			const text = serializeChildren(node, false).trim();
			return text ? `${text}\n\n` : "";
		}

		if (tag === "STRONG" || tag === "B") {
			const text = serializeChildren(node, inPre);
			if (!text.trim()) return text;
			const leading = text.match(/^\s*/)[0];
			const trailing = text.match(/\s*$/)[0];
			return `${leading}**${text.trim()}**${trailing}`;
		}

		if (tag === "EM" || tag === "I") {
			const text = serializeChildren(node, inPre);
			if (!text.trim()) return text;
			const leading = text.match(/^\s*/)[0];
			const trailing = text.match(/\s*$/)[0];
			return `${leading}*${text.trim()}*${trailing}`;
		}

		if (tag === "DEL" || tag === "S") {
			const text = serializeChildren(node, inPre).trim();
			return text ? `~~${text}~~` : "";
		}

		if (tag === "CODE") {
			if (inPre) return node.textContent || "";
			const text = node.textContent || "";
			if (!text) return "";
			if (text.includes("\n")) {
				return `\n\`\`\`\n${text.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
			}
			return `\`${text}\``;
		}

		if (tag === "CODE-BLOCK") {
			const langEl = node.querySelector(".code-block-decoration span, .language-label");
			const lang = (langEl?.textContent || "").trim().toLowerCase();
			const preEl = node.querySelector("pre");
			const codeText = preEl ? preEl.textContent || "" : serializeChildren(node, true);
			return `\n\`\`\`${lang}\n${codeText.replace(/\n$/, "")}\n\`\`\`\n\n`;
		}

		if (tag === "PRE") {
			const codeEl = node.querySelector("code");
			const langMatch = (codeEl?.className || "").match(/language-([a-zA-Z0-9_+-]+)/);
			const lang = langMatch ? langMatch[1] : "";
			const codeText = (codeEl ? codeEl.textContent : node.textContent) || "";
			return `\n\`\`\`${lang}\n${codeText.replace(/\n$/, "")}\n\`\`\`\n\n`;
		}

		if (tag === "BLOCKQUOTE") {
			const inner = serializeChildren(node, false).trim();
			if (!inner) return "";
			const quoted = inner.split("\n").map((line) => `> ${line}`).join("\n");
			return `${quoted}\n\n`;
		}

		if (tag === "UL") {
			const items = Array.from(node.children).filter((c) => c.tagName === "LI");
			if (items.length === 0) return serializeChildren(node, false);
			const lines = items
				.map((li) => {
					const text = serializeChildren(li, false)
						.trim()
						.replace(/\n{3,}/g, "\n\n")
						.replace(/\n/g, "\n  ");
					return text ? `- ${text}` : "";
				})
				.filter(Boolean);
			return lines.length ? `${lines.join("\n")}\n\n` : "";
		}

		if (tag === "OL") {
			const items = Array.from(node.children).filter((c) => c.tagName === "LI");
			if (items.length === 0) return serializeChildren(node, false);
			const startAttr = parseInt(node.getAttribute("start") || "1", 10) || 1;
			const lines = items
				.map((li, idx) => {
					const text = serializeChildren(li, false)
						.trim()
						.replace(/\n{3,}/g, "\n\n")
						.replace(/\n/g, "\n   ");
					return text ? `${startAttr + idx}.${text}` : "";
				})
				.filter(Boolean);
			return lines.length ? `${lines.join("\n")}\n\n` : "";
		}

		if (tag === "A") {
			const href = node.getAttribute("href") || "";
			const label = serializeChildren(node, false).trim();
			// 過濾 Gemini 自動將檔名轉成的 Google 搜尋假連結
			if (/^https?:\/\/(www\.)?google\.com\/search\?/i.test(href)) {
				return label ? `\`${label}\`` : "";
			}
			if (href && !href.startsWith("javascript:")) {
				return `[${label || href}](${href})`;
			}
			return label;
		}

		if (tag === "TABLE") {
			return serializeTable(node);
		}

		if (tag === "DIV") {
			const inner = serializeChildren(node, inPre);
			// If it's an inline / inline-flex container (e.g. URL chip), don't force-break sentences
			if (!isBlockDisplay(node)) return inner;
			const hasBlockChild = Array.from(node.children).some((c) =>
				/^(P|DIV|UL|OL|PRE|TABLE|BLOCKQUOTE|H[1-6]|CODE-BLOCK)$/.test(c.tagName),
			);
			return hasBlockChild ? inner : inner.trim() ? `${inner.trim()}\n\n` : "";
		}

		return serializeChildren(node, inPre);
	}

	function domToMarkdown(rootEl) {
		if (!rootEl) return "";
		const raw = serializeChildren(rootEl, false);
		return raw
			.replace(/\n{3,}/g, "\n\n")
			.replace(/^\n+/, "")
			.replace(/\n+$/, "");
	}

	// 掃描整頁獨立錯誤元素（如頂部 Snackbar），不限於聊天訊息內容
	function scanPageForErrors() {
		try {
			// Gemini 頂部 Snackbar / Toast 容器
			const snackbar = document.querySelector(
				"[class*='snack-bar'], [class*='snackbar'], [role='alert'], [aria-live='polite'], bard-multi-action-snack-bar",
			);
			if (snackbar) {
				const text = (snackbar.textContent || "").trim().replace(/[\u2018\u2019]/g, "'");
				const matched = GEMINI_SYSTEM_ERRORS.find(
					(msg) => text.startsWith(msg) || (text.length <= 220 && text.includes(msg)),
				);
				if (matched) return matched;
			}

			// 全頁 fallback：直接搜尋 body 文字中是否包含短錯誤代碼
			const bodyText = (document.body.textContent || "").replace(/[\u2018\u2019]/g, "'");
			const shortCodes = ["(1095)", "(1096)", "(1097)", "(1098)", "(1099)"];
			for (const code of shortCodes) {
				if (bodyText.includes(code)) return code;
			}
			const rateLimit = /Rate limit|rate limit|quota exceeded/i.test(bodyText);
			if (rateLimit) return "Rate limit";
		} catch (_) {}
		return null;
	}

	function checkStream(initialCount = 0) {
		if (streamInterval) {
			clearInterval(streamInterval);
			streamInterval = null;
		}

		let emittedText = "";
		let done = false;
		let sawStopButton = false;
		let emptyStopGoneSince = 0;
		let lastActivityAt = Date.now();

		streamInterval = setInterval(() => {
			const stopBtn = findStopButton();
			if (stopBtn) {
				sawStopButton = true;
				emptyStopGoneSince = 0;
				lastActivityAt = Date.now(); // 只要 Stop 按鈕仍在，代表 Gemini 正在思考/生成，絕不誤判超時
			}

			// 斷網即時偵測
			if (!done && navigator.onLine === false) {
				done = true;
				clearInterval(streamInterval);
				streamInterval = null;
				send({
					behaviour: "error",
					command: "start_completion",
					message: "Browser went offline during Gemini response.",
				});
				return;
			}

			// Stop 按鈕出現過後消失，但完全沒有輸出文字（請求中斷/網路錯誤）
			if (!done && sawStopButton && emittedText.length === 0 && !stopBtn) {
				if (!emptyStopGoneSince) emptyStopGoneSince = Date.now();
				if (Date.now() - emptyStopGoneSince > 3000) {
					done = true;
					clearInterval(streamInterval);
					streamInterval = null;
					send({
						behaviour: "error",
						command: "start_completion",
						message: "Gemini stopped responding with empty output (network drop or request aborted).",
					});
					return;
				}
			}

			// 僅在 Stop 按鈕已消失（或從未出現）且超過 45 秒無變化時才判定卡死
			if (!done && !stopBtn && Date.now() - lastActivityAt > 45000) {
				done = true;
				clearInterval(streamInterval);
				streamInterval = null;
				send({
					behaviour: "error",
					command: "start_completion",
					message: "Gemini UI stream stalled for 45s without completing.",
				});
				return;
			}

			// 全頁掃描獨立錯誤元素（如頂部 Snackbar），不限於聊天訊息內容
			const pageErr = scanPageForErrors();
			if (pageErr) {
				done = true;
				clearInterval(streamInterval);
				streamInterval = null;
				log("[BRIDGE ERROR] Gemini page error detected:", pageErr);
				send({
					behaviour: "error",
					command: "start_completion",
					message: `Gemini refused or errored to respond ${pageErr}. \n Likely that you have reached your rate limit.`,
				});
				return;
			}

			const nodes = document.querySelectorAll("model-response");
			if (nodes.length <= initialCount) return;

			const latest = nodes[nodes.length - 1];
			const el =
				latest.querySelector(
					".model-response-text, message-content, .markdown",
				) || latest;

			const plainCheck = (el.textContent || "").trim().replace(/[\u2018\u2019]/g, "'");
			const matchedErr = GEMINI_SYSTEM_ERRORS.find(
				(msg) =>
					plainCheck.startsWith(msg) ||
					(plainCheck.length <= 220 && plainCheck.includes(msg)),
			);
			if (matchedErr) {
				done = true;
				clearInterval(streamInterval);
				streamInterval = null;
				log("[BRIDGE ERROR] Gemini web returned:", plainCheck);
				send({
					behaviour: "error",
					command: "start_completion",
					message: `Gemini Web refused or errored: ${plainCheck}`,
				});
				return;
			}

			const current = domToMarkdown(el);

			// 行緩衝串流：生成中只發送「已出現換行符 \n」的穩定行，避免 Gemini 原地重繪加粗標籤導致文字重複
			if (stopBtn) {
				const lastNewlineIdx = current.lastIndexOf("\n");
				if (lastNewlineIdx !== -1) {
					const stablePrefix = current.slice(0, lastNewlineIdx + 1);
					if (stablePrefix.length > emittedText.length) {
						let common = 0;
						const maxLen = Math.min(emittedText.length, stablePrefix.length);
						while (common < maxLen && emittedText[common] === stablePrefix[common]) {
							common++;
						}
						const delta = stablePrefix.slice(common);
						emittedText = stablePrefix;
						if (delta) {
							send({
								behaviour: "message_stream",
								delta,
							});
						}
					}
				}
			}

			// 生成完成（Stop 按鈕已消失）：將最後剩餘未換行的尾巴一次發送完畢
			if (!done && current.length > 0 && !stopBtn) {
				done = true;
				clearInterval(streamInterval);
				streamInterval = null;

				let common = 0;
				const maxLen = Math.min(emittedText.length, current.length);
				while (common < maxLen && emittedText[common] === current[common]) {
					common++;
				}
				const remainingDelta = current.slice(common);
				if (remainingDelta) {
					send({
						behaviour: "message_stream",
						delta: remainingDelta,
					});
				}
				log("[COMPLETED]");
				send({ behaviour: "message_completed", finalText: current });
			}
		}, 50);
	}

	function initBridgeUI() {
		injectBridgeButton();
		let wasActiveInThisTab = false;
		try {
			wasActiveInThisTab = sessionStorage.getItem(SESSION_BRIDGE_KEY) === "1";
		} catch (_) {}
		if (wasActiveInThisTab) {
			log("Resuming active bridge in this tab after navigation/reload.");
			startBridge();
		}
	}

	if (document.body) {
		initBridgeUI();
	} else {
		window.addEventListener("DOMContentLoaded", initBridgeUI, { once: true });
	}
})();
