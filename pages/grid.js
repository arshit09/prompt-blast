/**
 * ============================================================
 *  Puchne — Grid View Script
 * ============================================================
 *
 *  Renders enabled AI services in a tiled CSS grid layout.
 *  All cells fill the container — resizing one cell pushes/pulls
 *  its neighbors (like split panes in VS Code / tmux).
 *
 *  Features:
 *    - 8-direction resize handles on every inner edge/corner
 *    - Drag-to-reposition by grabbing the title bar
 *    - Window resize scales proportionally (fractions stay fixed)
 *
 *  Frame-blocking headers are stripped by declarativeNetRequest
 *  rules in rules/grid_headers.json.
 * ============================================================
 */

const gridContainer = document.getElementById("gridContainer");
const queryBadge    = document.getElementById("queryBadge");

/* ── Layout State ──────────────────────────────────────────── */
let cols = 0;
let rows = 0;
let colFracs  = [];   // column width fractions, sum to 1
let rowFracs  = [];   // row height fractions, sum to 1
let cellMap   = [];   // [{ el, row, col, colSpan, service, index }]

const MIN_FRAC = 0.10; // minimum fraction for any track (10%)

/* ── Grid Template Helpers ─────────────────────────────────── */

function updateGridTemplate() {
  gridContainer.style.gridTemplateColumns = colFracs.map(f => (f * 100) + "%").join(" ");
  gridContainer.style.gridTemplateRows    = rowFracs.map(f => (f * 100) + "%").join(" ");
}

function placeCellInGrid(c) {
  c.el.style.gridColumn = `${c.col + 1} / span ${c.colSpan}`;
  c.el.style.gridRow    = `${c.row + 1}`;
}

/* ── Resize Handles ────────────────────────────────────────── */

/**
 * Each shared boundary is owned by exactly one cell to avoid
 * doubled hover highlights:
 *   - South handle  → owns the horizontal boundary below this cell
 *   - East handle   → owns the vertical boundary to the right
 *   - SE corner     → owns the intersection point
 * N, W, NW, NE, SW are never created — those boundaries belong
 * to the neighboring cell's S, E, or SE handle.
 */
function addResizeHandles(cellEl, cellObj) {
  const dirs = getActiveHandles(cellObj);
  dirs.forEach((dir) => {
    const handle = document.createElement("div");
    handle.className = `resize-handle rh-${dir}`;
    handle.dataset.dir = dir;

    // On hover, highlight all handles on the same full boundary line
    handle.addEventListener("mouseenter", () => highlightBoundary(cellObj, dir, true));
    handle.addEventListener("mouseleave", () => highlightBoundary(cellObj, dir, false));

    cellEl.appendChild(handle);
  });
}

/**
 * Highlight (or un-highlight) every handle that sits on the same
 * grid boundary as `dir` on `cellObj`.
 *
 *   - "s" handle at row R  → highlight all "s" handles in row R
 *   - "e" handle ending at col boundary B → highlight all "e" handles at B
 *   - "se" → highlight both the full row and full column line
 */
function highlightBoundary(cellObj, dir, on) {
  const cls = "rh-active";

  if (dir.includes("s")) {
    const rowBoundary = cellObj.row;
    for (const c of cellMap) {
      if (c.row === rowBoundary) {
        const h = c.el.querySelector(".rh-s");
        if (h) h.classList.toggle(cls, on);
      }
    }
  }

  if (dir.includes("e")) {
    const colBoundary = cellObj.col + cellObj.colSpan;
    for (const c of cellMap) {
      if (c.col + c.colSpan === colBoundary) {
        const h = c.el.querySelector(".rh-e");
        if (h) h.classList.toggle(cls, on);
      }
    }
  }

  // Also highlight the SE dot at the intersection if it exists
  if (dir === "s" || dir === "e") {
    const seCell = cellMap.find(c =>
      c.row === cellObj.row && c.col + c.colSpan === (dir === "s" ? cellObj.col + cellObj.colSpan : cellObj.col + cellObj.colSpan)
    );
    // For "s": find SE handle on the cell that shares both this row and has an east boundary
    // For "e": find SE handle on this cell's row
    const seHandle = cellObj.el.querySelector(".rh-se");
    if (seHandle) seHandle.classList.toggle(cls, on);
  }
}

function getActiveHandles(cellObj) {
  const atBottom = cellObj.row >= rows - 1;
  const atRight  = cellObj.col + cellObj.colSpan >= cols;

  const handles = [];
  if (!atBottom)              handles.push("s");
  if (!atRight)               handles.push("e");
  if (!atBottom && !atRight)  handles.push("se");
  return handles;
}

/* ── Iframe Overlay ────────────────────────────────────────── */

function createIframeOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "iframe-overlay";
  document.body.appendChild(overlay);
  return overlay;
}

function removeOverlay(overlay) {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

/* ── Resize Logic (tiled — push/pull neighbors) ────────────── */

function initResize(cellObj, dir, startX, startY) {
  const overlay = createIframeOverlay();
  const containerW = gridContainer.clientWidth;
  const containerH = gridContainer.clientHeight;

  // Snapshot fractions before drag
  const origColFracs = [...colFracs];
  const origRowFracs = [...rowFracs];

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Horizontal: east edge boundary (col+colSpan-1 ↔ col+colSpan)
    if (dir.includes("e")) {
      const tempCols = [...origColFracs];
      const leftIdx  = cellObj.col + cellObj.colSpan - 1;
      const rightIdx = cellObj.col + cellObj.colSpan;
      if (rightIdx < cols) {
        adjustFracs(tempCols, leftIdx, rightIdx, dx / containerW);
        colFracs = tempCols;
      }
    }

    // Vertical: south edge boundary (row ↔ row+1)
    if (dir.includes("s")) {
      const tempRows = [...origRowFracs];
      const topIdx    = cellObj.row;
      const bottomIdx = cellObj.row + 1;
      if (bottomIdx < rows) {
        adjustFracs(tempRows, topIdx, bottomIdx, dy / containerH);
        rowFracs = tempRows;
      }
    }

    updateGridTemplate();
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    removeOverlay(overlay);
    const cellOrder = [...cellMap]
      .sort((a, b) => a.row * cols + a.col - (b.row * cols + b.col))
      .map(c => c.service.id);
    chrome.storage.local.set({ gridLayout: { cols, rows, colFracs, rowFracs, cellOrder } });
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/**
 * Adjust two adjacent fractions: increase fracs[a] and decrease fracs[b]
 * by `delta`, clamping both to MIN_FRAC.
 */
function adjustFracs(fracs, a, b, delta) {
  let newA = fracs[a] + delta;
  let newB = fracs[b] - delta;

  // Clamp
  if (newA < MIN_FRAC) { newB += (newA - MIN_FRAC); newA = MIN_FRAC; }
  if (newB < MIN_FRAC) { newA += (newB - MIN_FRAC); newB = MIN_FRAC; }

  fracs[a] = newA;
  fracs[b] = newB;
}

/* ── Drag-to-Reposition (swap cells) ──────────────────────── */

function initDrag(cellObj, startX, startY) {
  const overlay = createIframeOverlay();
  const header  = cellObj.el.querySelector(".cell-header");

  // Get cell's current bounding rect to position the fixed clone
  const rect = cellObj.el.getBoundingClientRect();
  let dropTarget = null;

  // Create a placeholder to keep grid structure
  const ghost = document.createElement("div");
  ghost.className = "grid-cell drag-ghost";
  ghost.style.gridColumn = cellObj.el.style.gridColumn;
  ghost.style.gridRow    = cellObj.el.style.gridRow;
  gridContainer.insertBefore(ghost, cellObj.el);

  // Lift the cell out of flow
  cellObj.el.classList.add("dragging");
  cellObj.el.style.left   = rect.left + "px";
  cellObj.el.style.top    = rect.top + "px";
  cellObj.el.style.width  = rect.width + "px";
  cellObj.el.style.height = rect.height + "px";
  if (header) header.classList.add("grabbing");
  document.body.style.cursor = "grabbing";

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    cellObj.el.style.left = (rect.left + dx) + "px";
    cellObj.el.style.top  = (rect.top + dy) + "px";

    // Find drop target under cursor
    const newTarget = cellUnderPoint(e.clientX, e.clientY, cellObj);
    if (newTarget !== dropTarget) {
      if (dropTarget) dropTarget.el.classList.remove("drop-target");
      dropTarget = newTarget;
      if (dropTarget) dropTarget.el.classList.add("drop-target");
    }
  }

  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    removeOverlay(overlay);

    cellObj.el.classList.remove("dragging");
    cellObj.el.style.left = cellObj.el.style.top = cellObj.el.style.width = cellObj.el.style.height = "";
    if (header) header.classList.remove("grabbing");
    document.body.style.cursor = "";
    if (dropTarget) dropTarget.el.classList.remove("drop-target");

    // Remove ghost
    ghost.remove();

    if (dropTarget) {
      // Swap grid positions
      const aRow = cellObj.row, aCol = cellObj.col, aSpan = cellObj.colSpan;
      const bRow = dropTarget.row, bCol = dropTarget.col, bSpan = dropTarget.colSpan;

      cellObj.row = bRow;   cellObj.col = bCol;   cellObj.colSpan = bSpan;
      dropTarget.row = aRow; dropTarget.col = aCol; dropTarget.colSpan = aSpan;

      placeCellInGrid(cellObj);
      placeCellInGrid(dropTarget);

      // Update resize handle visibility for both cells
      refreshHandles(cellObj);
      refreshHandles(dropTarget);

      // Persist new cell order
      const cellOrder = [...cellMap]
        .sort((a, b) => a.row * cols + a.col - (b.row * cols + b.col))
        .map(c => c.service.id);
      chrome.storage.local.set({ gridLayout: { cols, rows, colFracs, rowFracs, cellOrder } });
    } else {
      // Snap back — just re-place in grid
      placeCellInGrid(cellObj);
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** Find a cellMap entry whose DOM element contains the given screen point. */
function cellUnderPoint(px, py, exclude) {
  for (const c of cellMap) {
    if (c === exclude) continue;
    const r = c.el.getBoundingClientRect();
    if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return c;
  }
  return null;
}

/** Refresh which resize handles are enabled/disabled for a cell. */
/** Remove old handles and re-create based on new grid position. */
function refreshHandles(cellObj) {
  cellObj.el.querySelectorAll(".resize-handle").forEach(h => h.remove());
  addResizeHandles(cellObj.el, cellObj);
}

/* ── Main ──────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", async () => {
  const stored   = await chrome.storage.sync.get("settings");
  const settings = stored.settings || {};
  const theme    = settings.theme || "dark";
  applyTheme(document.documentElement, theme);

  const data     = await chrome.storage.local.get("gridData");
  const gridData = data.gridData;

  if (!gridData || !gridData.targets || gridData.targets.length === 0) {
    showEmpty("No services to display. Enable some AI services in Settings.");
    return;
  }

  const query         = gridData.query || "";
  let   targets       = gridData.targets;
  const autoSubmit    = gridData.autoSubmit;
  const cookieConsent = gridData.cookieConsent || "accept";
  const delayMs       = gridData.delayMs;

  if (query) {
    const display = query.length > 80 ? query.slice(0, 80) + "\u2026" : query;
    queryBadge.textContent = `\u2014 "${display}"`;
  }

  // Compute grid dimensions
  cols = Math.min(targets.length, 3);
  rows = Math.ceil(targets.length / cols);

  // Initialize equal fractions
  colFracs = Array(cols).fill(1 / cols);
  rowFracs = Array(rows).fill(1 / rows);

  // Restore saved layout if grid dimensions match
  const savedLayout = await chrome.storage.local.get("gridLayout");
  const saved = savedLayout.gridLayout;
  if (saved && saved.cols === cols && saved.rows === rows &&
      Array.isArray(saved.colFracs) && saved.colFracs.length === cols &&
      Array.isArray(saved.rowFracs) && saved.rowFracs.length === rows) {
    colFracs = saved.colFracs;
    rowFracs = saved.rowFracs;
    // Restore cell order if saved and valid
    if (Array.isArray(saved.cellOrder) && saved.cellOrder.length === targets.length) {
      const byId = Object.fromEntries(targets.map(t => [t.id, t]));
      const reordered = saved.cellOrder.map(id => byId[id]).filter(Boolean);
      if (reordered.length === targets.length) targets = reordered;
    }
  }

  updateGridTemplate();

  // Determine last-row spanning
  const lastRowCount = targets.length - cols * (rows - 1);

  const isDark = theme === "dark";
  const iframeLoadPromises = [];

  targets.forEach((service, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const isLastRow = row === rows - 1 && lastRowCount < cols;

    let colStart, colSpan;
    if (isLastRow) {
      // Distribute last-row cells evenly across all columns
      const baseSpan = Math.floor(cols / lastRowCount);
      const extra    = cols % lastRowCount;
      const lastIdx  = i - cols * (rows - 1);   // index within last row
      // Compute start by summing previous last-row cells' spans
      colStart = 0;
      for (let j = 0; j < lastIdx; j++) {
        colStart += baseSpan + (j < extra ? 1 : 0);
      }
      colSpan = baseSpan + (lastIdx < extra ? 1 : 0);
    } else {
      colStart = col;
      colSpan  = 1;
    }

    const cell = document.createElement("div");
    cell.className = "grid-cell";

    const iconSrc = (isDark && service.iconPathDark) ? service.iconPathDark : service.iconPath;

    // Header bar (drag handle)
    const header = document.createElement("div");
    header.className = "cell-header";
    header.innerHTML = `
      <div class="cell-header-left">
        <img src="../${iconSrc}" alt="${service.name}">
        <span>${service.name}</span>
      </div>
      <button class="cell-open-btn" title="Open in a separate tab">Open in tab \u2197</button>
    `;
    header.querySelector(".cell-open-btn").addEventListener("click", () => {
      chrome.tabs.create({ url: service.url });
    });

    // Loading indicator
    const loading = document.createElement("div");
    loading.className = "cell-loading";
    loading.innerHTML = `<div class="spinner"></div> Loading ${service.name}\u2026`;

    // Iframe
    const iframe = document.createElement("iframe");
    iframe.className = "cell-iframe";
    iframe.src = service.url;
    iframe.style.display = "none";

    const loadPromise = new Promise((resolve) => {
      let settled = false;
      iframe.addEventListener("load", () => {
        if (settled) return;
        settled = true;
        loading.remove();
        iframe.style.display = "block";
        resolve({ service, ok: true });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        loading.remove();
        iframe.remove();
        showCellError(cell, service);
        resolve({ service, ok: false });
      }, 12000);
    });
    iframeLoadPromises.push(loadPromise);

    cell.appendChild(header);
    cell.appendChild(loading);
    cell.appendChild(iframe);

    const cellObj = { el: cell, row, col: colStart, colSpan, service, index: i };
    cellMap.push(cellObj);

    // Resize handles
    addResizeHandles(cell, cellObj);
    placeCellInGrid(cellObj);
    gridContainer.appendChild(cell);

    // ── Resize binding ──
    cell.addEventListener("mousedown", (e) => {
      const handle = e.target.closest(".resize-handle");
      if (!handle || handle.classList.contains("rh-disabled")) return;
      e.preventDefault();
      initResize(cellObj, handle.dataset.dir, e.clientX, e.clientY);
    });

    // ── Drag binding (header only, excluding buttons) ──
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      initDrag(cellObj, e.clientX, e.clientY);
    });
  });

  // Clean up one-time grid data
  await chrome.storage.local.remove("gridData");

  // Wait for all iframes
  const loadResults  = await Promise.all(iframeLoadPromises);
  const loadedTargets = loadResults.filter(r => r.ok).map(r => r.service);

  if (loadedTargets.length === 0) {
    console.warn("[Puchne Grid] No iframes loaded successfully.");
    return;
  }

  const tab = await chrome.tabs.getCurrent();
  if (!tab) return;

  console.log(`[Puchne Grid] Requesting injection for ${loadedTargets.length} frames...`);
  chrome.runtime.sendMessage(
    { action: "injectGridQueries", tabId: tab.id, targets: loadedTargets, query, autoSubmit, cookieConsent, delayMs },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Puchne Grid] Injection request failed:", chrome.runtime.lastError.message);
      } else {
        console.log("[Puchne Grid] Injection results:", response);
      }
    }
  );
});

/* ── Utility Functions ─────────────────────────────────────── */

function showEmpty(message) {
  gridContainer.innerHTML = `
    <div class="grid-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="9" y1="21" x2="9" y2="9"/>
      </svg>
      <p>${message}</p>
    </div>`;
}

function showCellError(cell, service) {
  const error = document.createElement("div");
  error.className = "cell-error";
  error.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
    <p>${service.name} could not be embedded.<br>Try opening it in a separate tab.</p>
    <a class="open-link" href="${service.url}" target="_blank">Open ${service.name} \u2197</a>
  `;
  cell.appendChild(error);
}
