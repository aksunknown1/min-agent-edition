#!/usr/bin/env node
/*
 * P0-12 MCP stdio adapter for the Min agent-rpc bridge.
 *
 * MCP over stdio per the spec (modelcontextprotocol.io, basic/transports):
 * newline-delimited JSON-RPC on stdin/stdout; NOTHING that is not a valid MCP
 * message is ever written to stdout; diagnostics go to stderr and are redacted
 * by construction (fixed labels, method/tool names, statuses - never
 * parameters, results, tokens or page content).
 *
 * Forwards exactly the 8 bridge tools. The bridge token is re-read from
 * <profileDir>/agent-rpc.json on EVERY call (Min writes a fresh token per
 * launch) and is used only in the local Authorization header - never written
 * to stdout, stderr or any log.
 *
 * usage: node mcp/min-agent-mcp.js [--profile=<dir>]
 *   default profile dir: %USERPROFILE%\.min-agent-profile (env
 *   MIN_AGENT_PROFILE also supported). The discovery file lives at
 *   <profileDir>-development/agent-rpc.json because Min runs in development
 *   mode and appends "-development" to its userData path; both spellings are
 *   checked.
 *
 * No npm dependencies. Implements: initialize, notifications/initialized,
 * tools/list, tools/call, ping.
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602

const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const FALLBACK_VERSION = '2025-03-26'
const SERVER_INFO = { name: 'min-agent', version: require(path.join(__dirname, '..', 'package.json')).version }

let negotiated = '2024-11-05'
let initialized = false

/* ---------- tool catalogue: mirrors the bridge schemas exactly ---------- */

const TOOLS = [
  {
    name: 'browser_status',
    description: 'Min bridge status: app/electron versions, window and tab counts, selected tab, bridge self-status. Takes no parameters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_health',
    description: 'Read-only doctor for THIS Min profile: overall healthy/degraded/unavailable plus per-check status for the bridge listener, discovery file, authentication, userData profile, managed download root, policy flags, live/crashed renderers, ad-blocker, network counters, ref store and tool catalogue. Never returns the bridge token, cookies or page content. Reports known permanent limitations honestly. Takes no parameters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_pdf',
    description: 'Render the current page of a tab to PDF in memory (Electron printToPDF). Returns base64 PDF bytes plus a bounded text metadata block. No file is written and nothing leaves the machine. Capture scope is the print rendering of the live attached view - NOT an offscreen or full-page browser capture. An adaptive scale ladder honours maxBytes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        landscape: { type: 'boolean', description: 'default false' },
        printBackground: { type: 'boolean', description: 'default false' },
        pageSize: { type: 'string', enum: ['A4', 'A5', 'A3', 'Letter', 'Legal', 'Tabloid', 'Ledger'], description: 'default A4' },
        margins: { type: 'boolean', description: 'default false (edge-to-edge)' },
        maxBytes: { type: 'integer', minimum: 20000, maximum: 8388608, description: 'encoded-output cap; a scale ladder retries until one rung fits' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
name: 'browser_helper_list',
    description: 'ADR-09 Option C: list the FIXED read-only built-in catalogue and the closed tool allowlist. Data only - no code executes. Takes no parameters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_helper',
    description: 'ADR-09 Option C: run a REGISTERED read-only built-in against one tab. The helper id is the only selector; a caller can never choose an arbitrary tool, reorder steps or widen privilege. Built-ins only observe page state - they never click, type, navigate, transform, download or change settings - and never prove that a remote site persisted a change. Available: page_summary (browser_state then browser_snapshot), form_control_inventory (browser_snapshot only; flat control list, values never returned).',
    inputSchema: {
      type: 'object',
      properties: {
        helper: { type: 'string', maxLength: 64, enum: ['page_summary', 'form_control_inventory'], description: 'registered built-in id' },
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id - explicit; never an implicit current tab' },
        version: { type: 'integer', minimum: 1, maximum: 1000, description: 'optional; must match the registered definition' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 200, description: 'snapshot node cap passed to the constituent call' },
        limit: { type: 'integer', minimum: 1, maximum: 60, description: 'form_control_inventory item cap' }
      },
      required: ['helper', 'tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_upload',
    description: 'R2/C6: attach ONE local file to a file input, by snapshot ref. The file must live under <profile>/agent-uploads and is validated by the same path policy as downloads (no absolute/UNC/traversal/symlink escape). Uses a single allowlisted browser command (DOM.setFileInputFiles). Never submits a form. Reports dispatched/delivered/verified separately; verified means the input reports the file attached.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'ref of a file input from browser_snapshot' },
        relPath: { type: 'string', maxLength: 240, description: 'path RELATIVE to <profile>/agent-uploads' }
      },
      required: ['tabId', 'ref', 'relPath'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_frames',
    description: 'R2/C8: enumerate the frame tree of a tab from Electron itself (no CDP). Lists the main frame and child frames with depth and URL. Cross-origin children are listed but their documents are not readable, and frame-scoped eval/click is NOT implemented in R2. Limitations are returned with the result.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_tabs',
    description: 'List open Min tabs (tabId, url, title, focused/active flags). Takes no parameters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_snapshot',
    description: 'Bounded accessibility-style snapshot of a tab: interactive nodes (button/link/textbox/checkbox/combobox/heading) with opaque ref handles valid for 60 seconds, used by browser_click/browser_type; names truncated to 120 chars; sensitive values length-only.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id from browser_tabs' },
        format: { type: 'string', enum: ['json', 'text'], description: 'default json' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'default 200' },
        waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'bounded settle delay before capturing, 0-5000ms; default 0' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to an http/https/file/min/about URL. javascript:/data:/vbscript: and other schemes are refused. Clears that tab\'s snapshot refs. Verifies the URL stays stable after load (default 1500ms window, resets on URL change) so delayed redirects and SPA route changes are reported as verified:false instead of false success.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        url: { type: 'string', maxLength: 2048, description: 'absolute url; http/https/file/min/about only' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded'], description: 'settle event; default load' },
        expectUrlPrefix: { type: 'string', maxLength: 300, description: 'require the final URL to start with this prefix; mismatch is reported as verification=redirected' },
        stabilityWindowMs: { type: 'integer', minimum: 0, maximum: 15000, description: 'post-load URL stability window, default 1500; resets on every URL change' }
      },
      required: ['tabId', 'url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_click',
    description: 'Click the element a snapshot ref points at, via native input events. Disabled elements are refused; purchase/payment-named elements require approval outside the bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'opaque ref from a fresh browser_snapshot (60s lifetime)' },
        verification: { type: 'string', enum: ['standard', 'none'], description: 'P1-15: none returns immediately after dispatch with an honest unverified status (for canvas/custom surfaces where immediate DOM verification is not meaningful)' }
      },
      required: ['tabId', 'ref'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_type',
    description: 'Replace the text of a textbox/combobox a snapshot ref points at, via native input events. Password/email/phone/sensitive-autocomplete fields are refused (single-use browser_grant sensitive_type unlocks one field). Acceptance is verified by reading the value back: verification=value (non-sensitive), value-length (sensitive, length only), rejected-input (framework refused), unreadable-state; strategy shows native-insert, keyboard-events or native-setter-fallback (one bounded retry).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'opaque ref pointing at a textbox/combobox' },
        text: { type: 'string', maxLength: 1000, description: 'text to enter (no control characters/newlines)' },
        mode: { type: 'string', enum: ['native', 'keyboard'], description: 'D3-A: native (default) = one native insertText; keyboard = one trusted keyDown/char/keyUp per character for framework/controlled inputs. Keyboard mode is bounded to 200 chars and reports physicalKeys:false when non-ASCII is delivered as text rather than a physical key sequence.' }
      },
      required: ['tabId', 'ref', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_press',
    description: 'Press one key in the focused page context. Keys: Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, Backspace, Delete. No modifiers or chords.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete'], description: 'single key' },
        verification: { type: 'string', enum: ['standard', 'none'], description: 'P1-15: none returns immediately after dispatch with an honest unverified status' }
      },
      required: ['tabId', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Screenshot of the Min view. Returns an MCP image content block (real image bytes) plus a text metadata block: screenshotId, viewport (CSS px), devicePixelRatio, scroll offsets, zoom, cssPerPixel conversion for browser_mouse coordinates. Requires an attached (selected) view. fullPage:true captures the WHOLE document via bounded scroll-stitching and reports completeCapture/truncated/scaledBy honestly.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'default png' },
        maxBytes: { type: 'integer', minimum: 5000, maximum: 5242880, description: 'P1-15: encoded-output cap; an adaptive ladder (downscale/recompress) retries until one rung fits, else an error with the attempts' },
        selector: { type: 'string', maxLength: 300, description: 'P1-15: optional CSS selector — element-scoped capture: validated rect, scrolled into view, cropped before encoding' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'jpeg quality (default 80)' },
        maxWidth: { type: 'integer', minimum: 16, maximum: 4096, description: 'aspect-preserving downscale' },
        maxHeight: { type: 'integer', minimum: 16, maximum: 4096, description: 'aspect-preserving downscale' },
        fullPage: { type: 'boolean', description: 'R2/D1: bounded scroll-stitch capture of the WHOLE document. Read the metadata block: completeCapture, truncated and scaledBy state honestly whether the image is the entire page.' },
        maxSlices: { type: 'integer', minimum: 1, maximum: 24, description: 'fullPage only: viewport slices to stitch; raise it for very long pages' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_tab_open',
    description: 'Open a new tab (optionally with a start URL). It becomes the selected view unless background: true. Uses the real Min tab model.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 2048, description: 'optional start URL; http/https/file/min/about only' },
        background: { type: 'boolean', description: 'default false; when true the tab opens unattached' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_tab_select',
    description: 'Make a tab the attached, visible view so click/type/screenshot work on it.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_tab_close',
    description: 'Close a tab. Refused for the last remaining tab. Clears its snapshot refs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}', description: 'Min tab id' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_content',
    description: 'Read the page text content of a tab (bounded, control-char stripped).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        maxChars: { type: 'integer', minimum: 200, maximum: 50000, description: 'default 20000; P1-15: minimum lowered from 1000 — smaller valid excerpts are supported' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element a snapshot ref points at (native mouse move).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'snapshot ref' }
      },
      required: ['tabId', 'ref'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_mouse',
    description: 'Typed page-level mouse (viewport CSS-pixel coordinates, explicit tabId). ACTIONS: move/hover (no click), click, rightClick, down, up, scroll (deltaX/deltaY wheel), movePath (smooth eased path from last position or fromX/fromY to toX/toY; mode instant|smooth), drag (button down -> path -> up), status (pressed/busy/last). Optional screenshotId: coordinates are screenshot-mapped and REJECTED as stale when the tab document, viewport, zoom or scroll changed. CAUTION: this is Electron page-level input, NOT the Windows system cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        action: { type: 'string', enum: ['move', 'hover', 'down', 'up', 'click', 'rightClick', 'scroll', 'movePath', 'drag', 'status'] },
        x: { type: 'integer', minimum: 0, description: 'target/point x in viewport CSS px' },
        y: { type: 'integer', minimum: 0, description: 'target/point y in viewport CSS px' },
        toX: { type: 'integer', minimum: 0, description: 'movePath/drag destination x' },
        toY: { type: 'integer', minimum: 0, description: 'movePath/drag destination y' },
        fromX: { type: 'integer', minimum: 0, description: 'movePath/drag start x (default: last position)' },
        fromY: { type: 'integer', minimum: 0, description: 'movePath/drag start y (default: last position)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'default left' },
        durationMs: { type: 'integer', minimum: 16, maximum: 5000, description: 'movePath/drag duration (default 500)' },
        mode: { type: 'string', enum: ['smooth', 'instant'], description: 'path quality (default smooth)' },
        steps: { type: 'integer', minimum: 2, maximum: 240, description: 'path event count override (bounded)' },
        deltaX: { type: 'integer', description: 'scroll horizontal delta' },
        deltaY: { type: 'integer', description: 'scroll vertical delta' },
        screenshotId: { type: 'string', pattern: '^ss[0-9]{1,12}$', description: 'reject stale coordinates from this screenshot when page state changed' }
      },
      required: ['tabId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page by delta or to top/bottom.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        y: { type: 'number', description: 'scrollBy y delta (positive = down)' },
        x: { type: 'number', description: 'scrollBy x delta' },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll to edge' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_select',
    description: 'Select an option in a select/combobox element by value or visible text. Uses native setter + change events for framework compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'snapshot ref pointing at a combobox' },
        value: { type: 'string', maxLength: 300, description: 'option value or text to select' }
      },
      required: ['tabId', 'ref', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_check',
    description: 'Check or uncheck a checkbox/radio via native input events. Verifies the state changed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'snapshot ref' },
        checked: { type: 'boolean', description: 'wanted state (true = checked)' }
      },
      required: ['tabId', 'ref', 'checked'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition: network_idle (quiet window; long-lived SSE/stream connections are ignored per D2-D semantics), selector_visible (CSS selector becomes visible), or ready_state (document.readyState becomes complete/interactive). Bounded timeout; returns what it actually waited on.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        until: { type: 'string', enum: ['network_idle', 'selector_visible', 'ready_state'], description: 'wait condition' },
        selector: { type: 'string', maxLength: 200, description: 'CSS selector (selector_visible only)' },
          maxQuietMs: { type: 'integer', minimum: 800, maximum: 10000, description: 'network_idle give-up window (default 3000): if new traffic keeps arriving past quietMs, the wait returns satisfied=true with drained=false so quiet is never reported as stopped' },
          quietMs: { type: 'integer', minimum: 300, maximum: 10000, description: 'network_idle quiet window (default 1000ms). Long-lived SSE/long-poll/websocket connections opened before the wait are baselined and ignored, so they cannot prevent idle; the count is reported as openLongLived.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 20000, description: 'default 8000' }
      },
      required: ['tabId', 'until'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_predict',
    description: 'STATIC prediction of an action effect on the element a ref points at, never triggering it. Returns target, likelyEffect, evidence[], confidence, sideEffectClass and requiresUserInput only when the effect cannot be known statically. JS-driven button effects are unknown (low confidence), never guessed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'snapshot ref' },
        action: { type: 'string', enum: ['click', 'type', 'check', 'select', 'press', 'hover'], description: 'the action you intend to perform' }
      },
      required: ['tabId', 'ref'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_verify',
    description: 'Cheapest post-action verification without a full snapshot: origin-checked URL prefix, a visible selector, or a body-text expectation, answered in one bounded page pass. Escalate to a snapshot only if inconclusive.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        urlPrefix: { type: 'string', maxLength: 300, description: 'origin-checked expected URL prefix' },
        selector: { type: 'string', maxLength: 200, description: 'CSS selector expected visible' },
        textContains: { type: 'string', maxLength: 200, description: 'your expectation string to find in the body text (value never returned)' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_transform',
    description: 'Reversible rendered-page transformations (local session only; never server-side): ops = replace_text, highlight, set_style (strict CSS allowlist), hide, restore_target, restore_all. Each entry targets a snapshot ref; per-target results include rendered post-state. State is cleared on navigation/tab close; drift is reported by browser_transform_status. NEVER runs on the seed of the page (server source untouched).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        actions: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace_text','highlight','set_style','hide','restore_target','restore_all'] },
              transformId: { type: 'string', pattern: '^tf[0-9]+$', description: 'restore_target only: exact transformedId from the apply result (documented P1-04.3 restore path)' },
              selector: { type: 'string', maxLength: 120, description: 'selector targeting (bounded CSS); alternative to ref' },
              ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$' },
              text: { type: 'string', maxLength: 1200, description: 'replace_text replacement' },
              style: { type: 'object', description: 'strict CSS allowlist: color, backgroundColor, fontSize, fontWeight, lineHeight, maxWidth, textAlign, visibility, padding*, margin*' }
            },
            required: ['op'],
            additionalProperties: false
          }
        }
      },
      required: ['tabId', 'actions'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_transform_status',
    description: 'Reports the current tab active-transformations count, per-op counts and drift (framework re-render overwrote a transform). No page content by default.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_batch',
    description: 'Execute an ordered list of typed browser actions in one round trip (max 20 steps, 60s budget, stop-on-error). Per-step results. Actions use the same schemas and safety rails as the standalone tools (grants, CAPTCHA handoff, input verification all still apply). browser_grant/browser_batch are not allowed inside a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'default tab id used by steps that need one' },
        actions: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['browser_status','browser_tabs','browser_snapshot','browser_content','browser_click','browser_type','browser_press','browser_hover','browser_scroll','browser_select','browser_check','browser_wait','browser_navigate','browser_screenshot','browser_downloads','browser_state','browser_tab_open','browser_tab_select','browser_tab_close','browser_eval','browser_viewport'] },
              params: { type: 'object', description: 'same schema as the standalone tool (tabId optional if it equals the batch default)' }
            },
            required: ['tool'],
            additionalProperties: false
          }
        }
      },
      required: ['tabId', 'actions'],
      stopOnError: { type: 'boolean', description: 'P1-15: default true — stop at the first failing step. With false, failing steps are reported and later steps continue.', default: true },
      recoverStale: { type: 'boolean', description: 'P1-15: default false — on ref_stale, re-snapshot once, re-resolve the target by identity (role+name+nameIndex), and retry the step once. Fails with an actionable error when identity does not re-resolve uniquely.', default: false },
      additionalProperties: false
    }
  },
  {
    name: 'browser_state',
    description: 'Lightweight page-state signals for the active tab: CAPTCHA detection (best-effort, kind + confidence + locator basis), apparently-blocked signal, focus state and in-flight request count. Used to poll for human-completed CAPTCHA handoff. Never returns page content.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        debugOverlay: { type: 'boolean', description: 'R4 probe aid: ask for the debug-click overlay report even when the profile has not enabled it (used to assert the default-disabled state). Enabling rendering itself requires debugClickOverlay:true in the profile policy.json.' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_downloads',
    description: 'List files downloaded in this Min session: read-only observation of ALL downloads plus detailed agent-managed jobs (downloadId, state, bytes, destination relative to the agent root).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_download_start',
    description: 'Start an agent-managed download. Two modes: direct (provide url, http/https only, optional relPath under the approved agent download root - never absolute, never outside the root) or adopt (provide armMs to arm the tab; the next page-triggered download in that tab is adopted, e.g. click a page download link yourself after arming). Resolves with downloadId once the download starts. No save dialog is shown for managed downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'target tab id' },
        url: { type: 'string', description: 'direct mode: http/https URL to download; no credentials in the URL' },
        relPath: { type: 'string', description: 'optional destination relative to the approved agent download root (subdirectories allowed, traversal/absolute/device names rejected)' },
        armMs: { type: 'number', description: 'adopt mode: arm the tab for this long (1000-120000ms) and adopt the next page-triggered download' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_download_wait',
    description: 'Wait for a managed download to reach a terminal state (completed/cancelled/interrupted). Bounded timeout; timeout returns a structured non-terminal result, never hangs.',
    inputSchema: {
      type: 'object',
      properties: {
        downloadId: { type: 'string', description: 'dlm<N> id from browser_download_start/browser_downloads' },
        timeoutMs: { type: 'number', description: 'bounded wait (100-120000, default 30000)' }
      },
      required: ['downloadId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression in the TARGET TAB\'s page main world (never in Node/server context) and return a JSON-safe result. Supports reading DOM state, computed properties, canvas pixel data (getImageData), storage, and awaited promises (awaitPromise). Exceptions, rejections, oversized output, cycles and non-serializable values are reported structurally. Timeout is bounded; an endless SYNCHRONOUS expression may keep the renderer busy after the call rejects — reload the page to recover. Expressions are authored by the calling agent: this is authorized, token-gated browser automation, not a sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        expression: { type: 'string', maxLength: 20000, description: 'JavaScript EXPRESSION to evaluate in the page main world (wrap statements in an IIFE). Returning DOM values, ImageData summaries, storage values, or awaited promises is supported; results are JSON-safe serialized.' },
        awaitPromise: { type: 'boolean', description: 'default true: await promise-returning expressions. With false, a promise result is reported as { __t: promise }, unresolved.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, description: 'bounded race for the evaluation, default 10000' },
        maxResultChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'serialized output cap with automatic tight-detail truncation, default 60000' }
      },
      required: ['tabId', 'expression'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_viewport',
    description: 'Set the per-tab viewport scale (zoom factor 0.25-3) for the target tab. Affects layout width, screenshot cssPerPixel mapping and coordinates. Restore by setting the returned previousZoom. Per-tab scale — not a window resize.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', pattern: '^[0-9]{1,20}$', description: 'Min tab id' },
        zoom: { type: 'number', minimum: 0.25, maximum: 3, description: 'zoom factor; omit or 1 = reset' }
      },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_download_cancel',
    description: 'Cancel one specific managed download job. Confirmation comes from the actual DownloadItem done event; other jobs are unaffected.',
    inputSchema: {
      type: 'object',
      properties: { downloadId: { type: 'string', description: 'dlm<N> id' } },
      required: ['downloadId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_download_pause',
    description: 'Pause one managed download. Honest structured result when the download is not in a pausable state.',
    inputSchema: {
      type: 'object',
      properties: { downloadId: { type: 'string', description: 'dlm<N> id' } },
      required: ['downloadId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_download_resume',
    description: 'Resume one paused/interrupted managed download. Only when Electron/server actually support resume (canResume) - an unsupported resume returns an honest structured refusal (a restart is never reported as a resume).',
    inputSchema: {
      type: 'object',
      properties: { downloadId: { type: 'string', description: 'dlm<N> id' } },
      required: ['downloadId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_grant',
    description: 'HARD RULE (see mcp/README.md section 3): call ONLY when the user explicitly instructs it in their own turn - one grant = ONE action. risky_click allows a single click on a purchase/payment-named element; sensitive_type allows typing into one password/email/sensitive field. Single-use, bound to the tab (and ref when given), TTL 30-300s.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['risky_click', 'sensitive_type'], description: 'the action category being user-approved' },
        tabId: { type: 'string', pattern: '^[0-9]{1,20}', description: 'Min tab id the grant applies to' },
        ref: { type: 'string', pattern: '^r[0-9a-z]{1,12}$', description: 'optional: bind the grant to one snapshot ref' },
        ttlSeconds: { type: 'integer', minimum: 30, maximum: 300, description: 'default 120' }
      },
      required: ['action', 'tabId'],
      additionalProperties: false
    }
  }
]

function toolNames () { return TOOLS.map(function (t) { return t.name }) }
function toolByName (name) {
  for (const t of TOOLS) if (t.name === name) return t
  return null
}

/* ---------- profile / discovery ---------- */

function profileDir () {
  for (const a of process.argv.slice(2)) {
    if (a.indexOf('--profile=') === 0) return a.slice(10)
  }
  if (process.env.MIN_AGENT_PROFILE) return process.env.MIN_AGENT_PROFILE
  return path.join(os.homedir(), '.min-agent-profile')
}

/* Min runs in development mode and appends "-development" to its userData;
 * check both spellings so the adapter survives a future change. */
function readDiscovery () {
  const dir = profileDir()
  const candidates = [dir + '-development' + path.sep + 'agent-rpc.json', path.join(dir, 'agent-rpc.json')]
  for (const f of candidates) {
    try {
      const disc = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (disc && disc.url && disc.token) return { disc: disc, file: f }
    } catch (e) { /* missing or mid-write (race with Min startup): try next */ }
  }
  const err = new Error('Min is not running, or its agent-rpc discovery file is missing, under "' + dir +
    '". Start Min first: node scripts/min-launch.js (visible window, agent-rpc on).')
  err.notRunning = true
  throw err
}

/* ---------- bridge client: local loopback, discovery re-read each call ---------- */

function bridgeCall (method, params) {
  const d = readDiscovery()
  const url = new URL(d.disc.url)
  return new Promise(function (resolve) {
    const body = JSON.stringify(Object.assign({ jsonrpc: '2.0', id: 'mcp' }, params !== undefined ? { method: method, params: params } : { method: method }))
    const req = http.request({
      host: url.hostname, port: Number(url.port), path: url.pathname, method: 'POST',
      headers: {
        host: url.host,
        authorization: 'Bearer ' + d.disc.token, /* loopback only; never logged or echoed */
        'content-type': 'application/json'
      },
      headersTimeout: 10000, requestTimeout: 30000
    }, function (res) {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', function () {
        let parsed = null
        try { parsed = JSON.parse(buf) } catch (e) { parsed = null }
        resolve({ status: res.statusCode, body: buf, parsed: parsed })
      })
    })
    req.on('error', function (e) { req.destroy(); resolve({ status: 0, error: String(e.code || e.message), body: '', parsed: null }) })
    req.setTimeout(30000, function () { req.destroy(); resolve({ status: 0, error: 'timeout', body: '', parsed: null }) })
    req.write(body)
    req.end()
  })
}

/* ---------- MCP frame helpers ---------- */

function send (frame) { process.stdout.write(JSON.stringify(frame) + '\n') }
function reply (id, result) { send({ jsonrpc: '2.0', id: id, result: result }) }
function replyError (id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) }
function replyToolError (id, message) { reply(id, { content: [{ type: 'text', text: message }], isError: true }) }
function log () {
  const parts = []
  for (const p of arguments) parts.push(typeof p === 'string' ? p : JSON.stringify(p))
  process.stderr.write('[min-agent-mcp] ' + parts.join(' ') + '\n')
}

/* ---------- tools/call ---------- */

function mcpToolResultFor (name, result) {
  if (name === 'browser_screenshot' && result && result.data && result.mimeType) {
    return {
      content: [
        { type: 'image', data: result.data, mimeType: result.mimeType },
        { type: 'text', text: JSON.stringify({
          tabId: result.tabId,
          screenshotId: result.screenshotId,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          source: result.source || 'full',
          scaled: result.scaled === true,
          attempts: typeof result.attempts === 'number' ? result.attempts : null,
          ladder: Array.isArray(result.ladder) ? result.ladder.slice(0, 6).map(r => ({ rung: r.rung, fmt: r.fmt, w: r.w, h: r.h, encoded: r.encoded })) : [],
          cropLimited: result.source === 'element' ? 'visible-area after scrollIntoView; NOT full-page or offscreen capture' : 'none',
          coordinateUnits: result.coordinateUnits,
          cssPerPixel: result.cssPerPixel,
          viewport: result.viewport,
          zoom: result.zoom,
          urlPath: result.urlPath,
          timestamp: result.timestamp,
          /* fullPage contract (present only for source 'fullpage'): without these
           * a client cannot tell a complete stitch from a first-slice fallback. */
          captureMode: result.captureMode,
          scaledBy: result.scaledBy,
          slices: result.slices,
          sliceHeightCss: result.sliceHeightCss,
          documentHeightCss: result.documentHeightCss,
          capturedHeightCss: result.capturedHeightCss,
          truncated: result.truncated,
          completeCapture: result.completeCapture,
          overByteCap: result.overByteCap,
          scrollRestoredTo: result.scrollRestoredTo,
          limitations: result.limitations
        }, null, 2) }
      ]
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
}

/* P1-15/D1-F12: bounded retry for the two states a Min RESTART actually
 * produces - the discovery file is momentarily absent while Min republishes
 * it (old token), and the previous port is refused for a moment (old url).
 * Nothing else is retried. In particular a timeout is never retried, and a
 * call that reached the bridge is never re-sent, so a single-use grant is
 * still consumed at most once and no side effect can be duplicated. */
const BRIDGE_TRANSIENT_CODES = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE']
const BRIDGE_RETRY_DELAYS_MS = [400, 1200]
const BRIDGE_RETRY_TOTAL_MS = 10000

function delayMs (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

async function bridgeCallWithRetry (method, params) {
  const startedAt = Date.now()
  for (let attempt = 0; ; attempt++) {
    let out = null
    let notRunning = null
    try {
      out = await bridgeCall(method, params)
    } catch (e) {
      if (!e.notRunning) throw e
      notRunning = e
    }
    const transient = notRunning
      ? true
      : (out.status === 0 && BRIDGE_TRANSIENT_CODES.indexOf(out.error) !== -1)
    const lastAttempt = attempt >= BRIDGE_RETRY_DELAYS_MS.length
    const outOfBudget = startedAt + BRIDGE_RETRY_DELAYS_MS[attempt] > Date.now() + BRIDGE_RETRY_TOTAL_MS
    if (!transient || lastAttempt || outOfBudget) {
      if (notRunning) throw notRunning
      return out
    }
    await delayMs(BRIDGE_RETRY_DELAYS_MS[attempt])
  }
}
/* P1-03: MCP clients send actions as a typed array; the bridge schema takes a
 * bounded JSON string. This is the ONLY per-tool transform the adapter needs. */
function prepareArgs (name, args) {
  const copy = Object.assign({}, args || {})
  if ((name === 'browser_batch' || name === 'browser_transform') && Array.isArray(copy.actions)) {
    copy.actions = JSON.stringify(copy.actions)
  }
  return copy
}

async function handleToolCall (id, callParams) {
  /* P1-15/D1-F9: this timer was referenced but never declared, so every
   * successful call threw a ReferenceError here (swallowed by the
   * uncaughtException handler) and duration logging never worked. */
  const t0 = Date.now()
  const name = callParams && callParams.name
  const tool = toolByName(name)
  if (!tool) {
    replyError(id, JSONRPC_INVALID_PARAMS, 'unknown tool: ' + String(name) + '; available: ' + toolNames().join(', '))
    return
  }
  let out
  try {
    out = await bridgeCallWithRetry(name, prepareArgs(name, callParams.arguments || {}))
  } catch (e) {
    if (e.notRunning) {
      replyToolError(id, e.message)
      log('tools/call', name, 'bridge not running')
      return
    }
    replyToolError(id, 'adapter failure forwarding the tool call: ' + e.message)
    log('tools/call', name, 'adapter error')
    return
  }
  if (out.status === 0 || !out.parsed) {
    replyToolError(id, 'Min bridge unreachable (' + (out.error || 'status ' + out.status) +
      '). Is Min running? Start it with: node scripts/min-launch.js --profile="' + profileDir() + '" --agent-rpc' +
      '  (P1-15: the adapter is configured with the profile above — discovery is read from <profile>/agent-rpc.json or <profile>-development/agent-rpc.json)')
    log('tools/call', name, 'unreachable')
    return
  }
  if (out.parsed.error) {
    const e = out.parsed.error
    replyToolError(id, (e.category || 'error') + ' ' + e.code + ': ' + e.message)
    log('tools/call', name, 'bridge error:', e.category)
    return
  }
  if (name === 'browser_grant') log('tools/call browser_grant — HARD RULE: this must be in response to an explicit user instruction (one grant = one action)')
  reply(id, mcpToolResultFor(name, out.parsed.result))
  log('tools/call', name, 'ok', (Date.now() - t0) + 'ms')
}

/* ---------- routing ---------- */

function route (msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.id === undefined || msg.id === null) {
    /* notification (no response frame) */
    if (msg.method === 'notifications/initialized') {
      initialized = true
      log('client initialized (protocol ' + negotiated + ')')
    }
    return
  }
  const id = msg.id
  const method = msg.method
  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion
    negotiated = SUPPORTED_VERSIONS.indexOf(requested) !== -1 ? requested : FALLBACK_VERSION
    /* initialize MUST be the first interaction; the client then sends
     * notifications/initialized. Tools are exposed via tools/list. */
    reply(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    })
    log('initialize: client requested ' + String(requested) + ' -> responding ' + negotiated)
    return
  }
  if (method === 'ping') { reply(id, {}); return }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return }
  if (method === 'tools/call') { handleToolCall(id, msg.params || {}); return }
  replyError(id, JSONRPC_METHOD_NOT_FOUND, 'unknown method: ' + String(method))
}

let outBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) {
  outBuffer += chunk
  let idx
  while ((idx = outBuffer.indexOf('\n')) !== -1) {
    const frame = outBuffer.slice(0, idx).trim()
    outBuffer = outBuffer.slice(idx + 1)
    if (!frame) continue
    let msg = null
    try { msg = JSON.parse(frame) } catch (e) {
      /* malformed input must not crash the server; answer as a parse error. */
      replyError(null, JSONRPC_PARSE_ERROR, 'parse error: input line was not valid JSON')
      continue
    }
    try { route(msg) } catch (e) {
      if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, 'internal adapter error')
      log('dispatch error:', e.message)
    }
  }
})
process.stdin.on('end', function () {
  /* MCP shutdown phase: the client closes stdin. */
  log('stdin closed; exiting')
  process.exit(0)
})
process.on('uncaughtException', function (e) {
  log('uncaught exception (server stays up):', e.message)
})

log('starting; profile=' + profileDir())
