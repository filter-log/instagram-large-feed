"use strict";

const COLUMN_COUNT = 3;
const TILE_SIZE = { width: 1080, height: 1350 };
const ROW_CANVAS_SIZE = { width: 3108, height: 1350 };
const COLUMN_CROPS = [
  { column: 1, name: "left", x: 0, width: TILE_SIZE.width },
  { column: 2, name: "center", x: 1014, width: TILE_SIZE.width },
  { column: 3, name: "right", x: 2028, width: TILE_SIZE.width },
];
const DEFAULT_FOCUS = { x: 0.5, y: 0.5 };
const DEFAULT_ZOOM = 1;
const LIVE_UPDATE_DELAY_MS = 120;

const generatorElements = {
  form: document.querySelector("#generator-form"),
  sourceInput: document.querySelector("#source-image"),
  sourceEditor: document.querySelector("#source-editor"),
  sourceZoom: document.querySelector("#source-zoom"),
  sourceZoomValue: document.querySelector("#source-zoom-value"),
  resetSourceButton: document.querySelector("#reset-source-button"),
  status: document.querySelector("#status"),
  results: document.querySelector("#results"),
  outputCount: document.querySelector("#output-count"),
  generateButton: document.querySelector("#generate-button"),
  downloadButton: document.querySelector("#download-button"),
};

const state = {
  rows: getRowCount(),
  sourceImage: null,
  sourceFocus: { ...DEFAULT_FOCUS },
  sourceZoom: DEFAULT_ZOOM,
  dragState: null,
  outputs: [],
  isGenerating: false,
  liveUpdateTimer: 0,
  zipFilename: "instagram-large-feed.zip",
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  if (document.body.dataset.page !== "generator") {
    return;
  }

  renderEmptyState();
  renderSourceEditor();
  updateZoomDisplay();

  generatorElements.form.addEventListener("submit", handleGenerate);
  generatorElements.form.addEventListener("input", handleFormEdit);
  generatorElements.form.addEventListener("change", handleFormEdit);
  generatorElements.sourceInput.addEventListener("change", handleSourceInputChange);
  generatorElements.sourceEditor.addEventListener("pointerdown", handleSourcePointerDown);
  generatorElements.sourceEditor.addEventListener("pointermove", handleSourcePointerMove);
  generatorElements.sourceEditor.addEventListener("pointerup", handleSourcePointerEnd);
  generatorElements.sourceEditor.addEventListener("pointercancel", handleSourcePointerEnd);
  generatorElements.resetSourceButton.addEventListener("click", resetSourcePosition);
  generatorElements.downloadButton.addEventListener("click", handleDownloadZip);
  window.addEventListener("resize", renderSourceEditor);

  setStatus("Ready");
}

function getRowCount() {
  const parsed = Number(document.body.dataset.rows || 1);
  if ([1, 2, 3].includes(parsed)) {
    return parsed;
  }
  return 1;
}

async function handleGenerate(event) {
  event.preventDefault();
  await regenerateOutputs({ clearBeforeGenerate: true });
}

async function handleSourceInputChange() {
  resetGeneratedImage();
  state.sourceFocus = { ...DEFAULT_FOCUS };
  state.sourceZoom = DEFAULT_ZOOM;
  generatorElements.sourceZoom.value = String(DEFAULT_ZOOM * 100);
  updateZoomDisplay();

  const file = generatorElements.sourceInput.files?.[0];
  if (!file) {
    state.sourceImage = null;
    generatorElements.generateButton.disabled = true;
    generatorElements.resetSourceButton.disabled = true;
    renderSourceEditor();
    return;
  }

  try {
    setStatus("Loading image");
    state.sourceImage = await loadUploadImage(file, "Source");
    generatorElements.generateButton.disabled = false;
    generatorElements.resetSourceButton.disabled = false;
    state.zipFilename = makeZipFilename(file.name, state.rows);
    renderSourceEditor();
    await regenerateOutputs({ clearBeforeGenerate: true });
  } catch (error) {
    state.sourceImage = null;
    generatorElements.generateButton.disabled = true;
    generatorElements.resetSourceButton.disabled = true;
    renderSourceEditor();
    setStatus(error.message || "Could not load image", "error");
  }
}

function handleFormEdit(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target === generatorElements.sourceInput) {
    return;
  }

  if (target === generatorElements.sourceZoom) {
    state.sourceZoom = Number(generatorElements.sourceZoom.value) / 100;
    updateZoomDisplay();
    renderSourceEditor();
  }

  scheduleLiveRegenerate();
}

async function regenerateOutputs({ clearBeforeGenerate }) {
  if (state.isGenerating) {
    return;
  }

  if (clearBeforeGenerate) {
    resetGeneratedImage();
  }

  state.isGenerating = true;
  setBusy(true);
  try {
    if (!state.sourceImage) {
      throw new Error("Source image is required");
    }

    const options = collectOptions();
    validateOptions(options);
    setStatus("Generating");
    const outputs = await generateFeedPieces(options);
    replaceOutputs(outputs);
    setStatus(`${outputs.length} files generated`, "success");
  } catch (error) {
    if (!state.outputs.length) {
      renderEmptyState();
    }
    setStatus(error.message || "Generation failed", "error");
  } finally {
    state.isGenerating = false;
    setBusy(false);
  }
}

function collectOptions() {
  const formData = new FormData(generatorElements.form);
  return {
    format: formData.get("format") === "png" ? "png" : "jpg",
    quality: Number(formData.get("quality") || 95) / 100,
    rows: state.rows,
    focus: { ...state.sourceFocus },
    zoom: state.sourceZoom,
  };
}

function validateOptions(options) {
  if (!Number.isInteger(options.rows) || options.rows < 1 || options.rows > 3) {
    throw new Error("Unsupported row count");
  }
  if (!["jpg", "png"].includes(options.format)) {
    throw new Error("Unsupported output format");
  }
  if (!Number.isFinite(options.quality) || options.quality < .7 || options.quality > 1) {
    throw new Error("JPG quality is out of range");
  }
}

async function generateFeedPieces(options) {
  const targetSize = getTargetCanvasSize(options.rows);
  const extension = options.format;
  const mimeType = options.format === "png" ? "image/png" : "image/jpeg";
  const sourceCanvas = createCanvas(targetSize.width, targetSize.height);
  const sourceContext = sourceCanvas.getContext("2d");

  sourceContext.fillStyle = "#ffffff";
  sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  drawCoverImage(
    sourceContext,
    state.sourceImage,
    targetSize.width,
    targetSize.height,
    options.focus,
    options.zoom,
  );

  const outputs = [];
  let index = 1;
  for (let rowIndex = 0; rowIndex < options.rows; rowIndex += 1) {
    for (const crop of COLUMN_CROPS) {
      const canvas = cropCanvas(sourceCanvas, {
        x: crop.x,
        y: rowIndex * ROW_CANVAS_SIZE.height,
        width: TILE_SIZE.width,
        height: TILE_SIZE.height,
      });
      const rowNumber = rowIndex + 1;
      outputs.push(await makeOutput(
        canvas,
        `${String(index).padStart(2, "0")}_row${rowNumber}_${crop.name}.${extension}`,
        mimeType,
        options.quality,
      ));
      index += 1;
    }
  }

  return outputs;
}

function handleSourcePointerDown(event) {
  if (!state.sourceImage) {
    return;
  }

  generatorElements.sourceEditor.setPointerCapture(event.pointerId);
  generatorElements.sourceEditor.classList.add("is-dragging");
  state.dragState = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  };
}

function handleSourcePointerMove(event) {
  if (!state.dragState || state.dragState.pointerId !== event.pointerId || !state.sourceImage) {
    return;
  }

  const targetSize = getTargetCanvasSize(state.rows);
  const rect = generatorElements.sourceEditor.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const deltaX = (event.clientX - state.dragState.lastX) * targetSize.width / rect.width;
  const deltaY = (event.clientY - state.dragState.lastY) * targetSize.height / rect.height;
  state.dragState.lastX = event.clientX;
  state.dragState.lastY = event.clientY;

  moveSourceBy(deltaX, deltaY);
  renderSourceEditor();
  scheduleLiveRegenerate();
}

function handleSourcePointerEnd(event) {
  if (state.dragState?.pointerId !== event.pointerId) {
    return;
  }

  generatorElements.sourceEditor.classList.remove("is-dragging");
  state.dragState = null;
}

function resetSourcePosition() {
  state.sourceFocus = { ...DEFAULT_FOCUS };
  state.sourceZoom = DEFAULT_ZOOM;
  generatorElements.sourceZoom.value = String(DEFAULT_ZOOM * 100);
  updateZoomDisplay();
  renderSourceEditor();
  scheduleLiveRegenerate();
}

function moveSourceBy(deltaX, deltaY) {
  const targetSize = getTargetCanvasSize(state.rows);
  const metrics = getCoverMetrics(
    state.sourceImage,
    targetSize.width,
    targetSize.height,
    state.sourceFocus,
    state.sourceZoom,
  );
  const rangeX = targetSize.width - metrics.drawWidth;
  const rangeY = targetSize.height - metrics.drawHeight;

  if (rangeX !== 0) {
    state.sourceFocus.x = clamp(state.sourceFocus.x + deltaX / rangeX, 0, 1);
  }
  if (rangeY !== 0) {
    state.sourceFocus.y = clamp(state.sourceFocus.y + deltaY / rangeY, 0, 1);
  }
}

function renderSourceEditor() {
  if (!generatorElements.sourceEditor) {
    return;
  }

  const canvas = generatorElements.sourceEditor;
  const targetSize = getTargetCanvasSize(state.rows);
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width || canvas.clientWidth || 920));
  const cssHeight = Math.round(cssWidth * targetSize.height / targetSize.width);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * pixelRatio);
  canvas.height = Math.round(cssHeight * pixelRatio);
  canvas.style.aspectRatio = `${targetSize.width} / ${targetSize.height}`;

  const context = canvas.getContext("2d");
  context.setTransform(canvas.width / targetSize.width, 0, 0, canvas.height / targetSize.height, 0, 0);
  context.clearRect(0, 0, targetSize.width, targetSize.height);
  context.fillStyle = "#edf1ef";
  context.fillRect(0, 0, targetSize.width, targetSize.height);

  canvas.classList.toggle("is-empty", !state.sourceImage);
  if (state.sourceImage) {
    drawCoverImage(
      context,
      state.sourceImage,
      targetSize.width,
      targetSize.height,
      state.sourceFocus,
      state.sourceZoom,
    );
  }

  drawCropGuides(context, targetSize);
}

function drawCropGuides(context, targetSize) {
  context.save();
  context.lineWidth = 4;
  context.shadowColor = "rgba(0, 0, 0, .72)";
  context.shadowBlur = 12;
  context.shadowOffsetY = 3;
  context.strokeStyle = "rgba(255, 255, 255, .94)";
  for (let rowIndex = 0; rowIndex < state.rows; rowIndex += 1) {
    for (const crop of COLUMN_CROPS) {
      context.strokeRect(
        crop.x + 2,
        rowIndex * ROW_CANVAS_SIZE.height + 2,
        crop.width - 4,
        TILE_SIZE.height - 4,
      );
    }
  }

  context.shadowColor = "transparent";
  context.strokeStyle = "rgba(21, 127, 108, .92)";
  context.setLineDash([18, 14]);
  context.strokeRect(2, 2, targetSize.width - 4, targetSize.height - 4);
  context.restore();
}

function drawCoverImage(context, image, targetWidth, targetHeight, focus, zoom) {
  const metrics = getCoverMetrics(image, targetWidth, targetHeight, focus, zoom);
  context.drawImage(image, metrics.drawX, metrics.drawY, metrics.drawWidth, metrics.drawHeight);
}

function getCoverMetrics(image, targetWidth, targetHeight, focus = DEFAULT_FOCUS, zoom = DEFAULT_ZOOM) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * Math.max(1, zoom);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  return {
    drawWidth,
    drawHeight,
    drawX: (targetWidth - drawWidth) * clamp(focus.x, 0, 1),
    drawY: (targetHeight - drawHeight) * clamp(focus.y, 0, 1),
  };
}

function getTargetCanvasSize(rows) {
  return {
    width: ROW_CANVAS_SIZE.width,
    height: ROW_CANVAS_SIZE.height * rows,
  };
}

function cropCanvas(sourceCanvas, crop) {
  const canvas = createCanvas(crop.width, crop.height);
  const context = canvas.getContext("2d");
  context.drawImage(
    sourceCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return canvas;
}

async function makeOutput(canvas, filename, mimeType, quality) {
  const blob = await canvasToBlob(canvas, mimeType, quality);
  return {
    filename,
    blob,
    url: URL.createObjectURL(blob),
    width: canvas.width,
    height: canvas.height,
  };
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not encode canvas"));
      }
    }, mimeType, quality);
  });
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function loadUploadImage(value, label) {
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} file is required`);
  }
  if (value.type && !value.type.startsWith("image/")) {
    throw new Error(`${label} must be a browser-readable image`);
  }

  const url = URL.createObjectURL(value);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image"));
    image.src = src;
  });
}

function scheduleLiveRegenerate() {
  if (!state.sourceImage || !state.outputs.length) {
    return;
  }

  window.clearTimeout(state.liveUpdateTimer);
  state.liveUpdateTimer = window.setTimeout(() => {
    regenerateOutputs({ clearBeforeGenerate: false });
  }, LIVE_UPDATE_DELAY_MS);
}

function replaceOutputs(outputs) {
  revokeOutputUrls(state.outputs);
  state.outputs = outputs;
  renderOutputs(outputs);
}

function renderOutputs(outputs) {
  generatorElements.results.textContent = "";

  const fragment = document.createDocumentFragment();
  for (let rowIndex = 0; rowIndex < state.rows; rowIndex += 1) {
    const rowOutputs = outputs.slice(rowIndex * COLUMN_COUNT, rowIndex * COLUMN_COUNT + COLUMN_COUNT);
    fragment.append(createOutputSection(`Row ${rowIndex + 1}`, formatFileCount(rowOutputs.length), rowOutputs));
  }

  generatorElements.results.append(fragment);
  generatorElements.outputCount.textContent = formatFileCount(outputs.length);
  generatorElements.downloadButton.disabled = outputs.length === 0;
}

function createOutputSection(title, count, outputs) {
  const section = document.createElement("section");
  section.className = "output-section";

  const head = document.createElement("div");
  head.className = "section-head";

  const heading = document.createElement("h3");
  heading.textContent = title;

  const countText = document.createElement("span");
  countText.textContent = count;

  const grid = document.createElement("div");
  grid.className = "output-grid feed-grid";

  for (const output of outputs) {
    grid.append(createOutputItem(output));
  }

  head.append(heading, countText);
  section.append(head, grid);
  return section;
}

function createOutputItem(output) {
  const figure = document.createElement("figure");
  figure.className = "output-item";

  const image = document.createElement("img");
  image.src = output.url;
  image.alt = output.filename;
  image.width = output.width;
  image.height = output.height;

  const meta = document.createElement("figcaption");
  meta.className = "output-meta";

  const name = document.createElement("strong");
  name.textContent = output.filename;

  const link = document.createElement("a");
  link.href = output.url;
  link.download = output.filename;
  link.textContent = "Download";

  meta.append(name, link);
  figure.append(image, meta);
  return figure;
}

function renderEmptyState() {
  generatorElements.results.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "No output";
  generatorElements.results.append(empty);
  generatorElements.outputCount.textContent = formatFileCount(0);
  generatorElements.downloadButton.disabled = true;
}

function resetGeneratedImage() {
  revokeOutputUrls(state.outputs);
  state.outputs = [];
  renderEmptyState();
}

function revokeOutputUrls(outputs) {
  for (const output of outputs) {
    URL.revokeObjectURL(output.url);
  }
}

function setBusy(isBusy) {
  generatorElements.generateButton.disabled = isBusy || !state.sourceImage;
  generatorElements.downloadButton.disabled = isBusy || state.outputs.length === 0;
}

function setStatus(message, tone) {
  generatorElements.status.textContent = message;
  generatorElements.status.classList.toggle("is-error", tone === "error");
  generatorElements.status.classList.toggle("is-success", tone === "success");
}

function updateZoomDisplay() {
  generatorElements.sourceZoomValue.textContent = `${Math.round(state.sourceZoom * 100)}%`;
}

function formatFileCount(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function handleDownloadZip() {
  if (!state.outputs.length) {
    return;
  }
  generatorElements.downloadButton.disabled = true;
  setStatus("Preparing ZIP");
  try {
    const zipBlob = await createZip(state.outputs);
    downloadBlob(zipBlob, state.zipFilename);
    setStatus("ZIP ready", "success");
  } catch (error) {
    setStatus(error.message || "Could not create ZIP", "error");
  } finally {
    generatorElements.downloadButton.disabled = false;
  }
}

async function createZip(outputs) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const records = [];
  let offset = 0;

  for (const output of outputs) {
    const nameBytes = encoder.encode(output.filename);
    const data = new Uint8Array(await output.blob.arrayBuffer());
    const crc = crc32(data);
    const localHeader = makeLocalHeader(nameBytes, data, crc);
    localParts.push(localHeader, data);
    records.push({ nameBytes, data, crc, offset });
    offset += localHeader.byteLength + data.byteLength;
  }

  let centralSize = 0;
  for (const record of records) {
    const centralHeader = makeCentralHeader(record.nameBytes, record.data, record.crc, record.offset);
    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
  }

  const endHeader = makeEndOfCentralDirectory(records.length, centralSize, offset);
  return new Blob([...localParts, ...centralParts, endHeader], { type: "application/zip" });
}

function makeLocalHeader(nameBytes, data, crc) {
  const header = new ArrayBuffer(30 + nameBytes.length);
  const view = new DataView(header);
  const { dosTime, dosDate } = getDosTimestamp();
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 10, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  new Uint8Array(header, 30).set(nameBytes);
  return new Uint8Array(header);
}

function makeCentralHeader(nameBytes, data, crc, localOffset) {
  const header = new ArrayBuffer(46 + nameBytes.length);
  const view = new DataView(header);
  const { dosTime, dosDate } = getDosTimestamp();
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 10, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, data.byteLength, true);
  view.setUint32(24, data.byteLength, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  new Uint8Array(header, 46).set(nameBytes);
  return new Uint8Array(header);
}

function makeEndOfCentralDirectory(fileCount, centralSize, centralOffset) {
  const header = new ArrayBuffer(22);
  const view = new DataView(header);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return new Uint8Array(header);
}

function getDosTimestamp() {
  const date = new Date();
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(data) {
  let crc = -1;
  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeZipFilename(filename, rows) {
  const baseName = sanitizeFilenamePart(filename.replace(/\.[^.]+$/, "")) || "instagram-large-feed";
  return `${baseName}_3x${rows}.zip`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}
