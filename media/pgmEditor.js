// @ts-check
(function () {
    const vscode = acquireVsCodeApi();

    /** @type {HTMLCanvasElement} */
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    const toolSelect = document.getElementById('tool');
    const saveButton = document.getElementById('saveButton');
    const colorSwatch = document.getElementById('colorSwatch');
    const grayValueInput = document.getElementById('grayValue');
    const grayValueLabel = document.getElementById('grayValueLabel');
    const speedPctInput = document.getElementById('speedPct');
    const speedPctLabel = document.getElementById('speedPctLabel');
    const thicknessWrap = document.getElementById('thicknessWrap');
    const thicknessInput = document.getElementById('thickness');
    const thicknessLabel = document.getElementById('thicknessLabel');
    const zoomInput = document.getElementById('zoomLevel');
    const zoomLabel = document.getElementById('zoomLabel');
    const referenceToggleWrap = document.getElementById('referenceToggleWrap');
    const referenceToggle = document.getElementById('referenceToggle');
    const referenceOpacity = document.getElementById('referenceOpacity');
    const canvasWrap = document.querySelector('.canvas-wrap');
    const overlayMode = document.getElementById('overlayMode');

    /** @type {{width:number,height:number,maxval:number,original:Uint8ClampedArray,edits:any[],reference:{width:number,height:number,pixels:Uint8ClampedArray}|null}} */
    let state = null;
    let zoom = Number(zoomInput.value);

    // Offscreen 1:1 buffer we paint into, then blit scaled-up onto the visible canvas.
    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d');

    let livePixels = null;       // working copy shown while actively interacting
    let currentStroke = null;    // brush/eraser: { points, grayValue, thickness }
    let lastPoint = null;        // brush/eraser: last sampled point, for interpolation
    let lineStart = null;        // line tool: drag start
    let rectStart = null;        // rectangle tool: drag start
    let polygonPoints = [];      // polygon tool: vertices placed so far
    let polygonCursor = null;    // polygon tool: current mouse position, for the live preview edge
    let selectedEditIndex = -1;  // select tool: edit currently being moved
    let moveStart = null;
    let moveOriginal = null;

    function currentTool() { return toolSelect.value; }
    toolSelect.addEventListener('change', updateToolUI);
    saveButton.addEventListener('click', () => vscode.postMessage({ type: 'save' }));

    // --- gray % <-> speed % linkage -------------------------------------------------------
    // speed_limit_% = (pixel_value / 255) * 100, for this project's speed_mask config
    // (base=100, multiplier=-1) - the same linear scale as "gray %", so both sliders always
    // show the same number here. Speed % is kept as its own control since that's the unit
    // you actually think in when editing speed_mask.pgm.
    function setPct(pct) {
        grayValueInput.value = String(pct);
        grayValueLabel.textContent = String(pct);
        speedPctInput.value = String(pct);
        speedPctLabel.textContent = String(pct);
        const v = Math.round((pct / 100) * 255);
        colorSwatch.style.background = `rgb(${v},${v},${v})`;
    }
    /** The actual 0-255 pixel value the gray % slider currently represents. */
    function currentGrayValue() {
        return Math.round((Number(grayValueInput.value) / 100) * 255);
    }
    grayValueInput.addEventListener('input', () => setPct(Number(grayValueInput.value)));
    speedPctInput.addEventListener('input', () => setPct(Number(speedPctInput.value)));

    // --- edit application (mirrors src/pgmEditor.ts's applyEdit exactly) ------------------
    function fillPolygon(pixels, width, height, edit) {
        const pts = edit.points;
        if (pts.length < 3) { return; }
        const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
        const maxY = Math.min(height - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));
        for (let y = minY; y <= maxY; y++) {
            const yc = y + 0.5;
            const xs = [];
            for (let i = 0; i < pts.length; i++) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % pts.length];
                if ((p1.y <= yc && p2.y > yc) || (p2.y <= yc && p1.y > yc)) {
                    const t = (yc - p1.y) / (p2.y - p1.y);
                    xs.push(p1.x + t * (p2.x - p1.x));
                }
            }
            xs.sort((a, b) => a - b);
            for (let i = 0; i + 1 < xs.length; i += 2) {
                const xStart = Math.max(0, Math.round(xs[i]));
                const xEnd = Math.min(width - 1, Math.round(xs[i + 1]));
                for (let x = xStart; x <= xEnd; x++) {
                    const index = y * width + x;
                    if (!edit.overlay || pixels[index] > edit.grayValue) { pixels[index] = edit.grayValue; }
                }
            }
        }
    }

    function applyEdit(pixels, width, height, edit) {
        if (edit.type === 'polygon') { fillPolygon(pixels, width, height, edit); return; }

        if (edit.type === 'rect') {
            const minX = Math.max(0, Math.floor(Math.min(edit.x0, edit.x1)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(edit.x0, edit.x1)));
            const minY = Math.max(0, Math.floor(Math.min(edit.y0, edit.y1)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(edit.y0, edit.y1)));
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const index = y * width + x;
                    if (!edit.overlay || pixels[index] > edit.grayValue) { pixels[index] = edit.grayValue; }
                }
            }
            return;
        }

        const radius = edit.thickness / 2;
        const r2 = radius * radius;
        for (const { x: cx, y: cy } of edit.points) {
            const minX = Math.max(0, Math.floor(cx - radius));
            const maxX = Math.min(width - 1, Math.ceil(cx + radius));
            const minY = Math.max(0, Math.floor(cy - radius));
            const maxY = Math.min(height - 1, Math.ceil(cy + radius));
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const dx = x - cx, dy = y - cy;
                    const index = y * width + x;
                    if (dx * dx + dy * dy <= r2 && (!edit.overlay || pixels[index] > edit.grayValue)) {
                        pixels[index] = edit.grayValue;
                    }
                }
            }
        }
    }

    function computePixels() {
        const pixels = state.original.slice();
        for (const edit of state.edits) { applyEdit(pixels, state.width, state.height, edit); }
        return pixels;
    }

    function translateEdit(edit, dx, dy) {
        if (edit.type === 'rect') {
            return { ...edit, x0: edit.x0 + dx, y0: edit.y0 + dy, x1: edit.x1 + dx, y1: edit.y1 + dy };
        }
        return { ...edit, points: edit.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    }

    function pointInPolygon(point, points) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const a = points[i], b = points[j];
            if ((a.y > point.y) !== (b.y > point.y) &&
                point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
        return inside;
    }

    function editContainsPoint(edit, point) {
        if (edit.type === 'rect') {
            return point.x >= Math.min(edit.x0, edit.x1) && point.x <= Math.max(edit.x0, edit.x1) &&
                point.y >= Math.min(edit.y0, edit.y1) && point.y <= Math.max(edit.y0, edit.y1);
        }
        if (edit.type === 'polygon') { return pointInPolygon(point, edit.points); }
        const radius = edit.thickness / 2;
        return edit.points.some((center) => {
            const dx = point.x - center.x, dy = point.y - center.y;
            return dx * dx + dy * dy <= radius * radius;
        });
    }

    function findEditAtPoint(point) {
        for (let i = state.edits.length - 1; i >= 0; i--) {
            if (editContainsPoint(state.edits[i], point)) { return i; }
        }
        return -1;
    }

    function computePixelsWithMovedEdit(index, movedEdit) {
        const pixels = state.original.slice();
        state.edits.forEach((edit, editIndex) => {
            applyEdit(pixels, state.width, state.height, editIndex === index ? movedEdit : edit);
        });
        return pixels;
    }

    // --- rendering -------------------------------------------------------------------------
    function render(pixels, overlay) {
        offscreen.width = state.width;
        offscreen.height = state.height;
        const imageData = offCtx.createImageData(state.width, state.height);
        const ref = state.reference;
        const showRef = ref && referenceToggle.checked;
        const refAlpha = Number(referenceOpacity.value) / 100;

        for (let i = 0; i < pixels.length; i++) {
            const v = pixels[i];
            // Unpainted (white) pixels show a faint version of the real map underneath, so you
            // can see walls/furniture while deciding where to paint. Painted pixels stay solid -
            // what you painted is exactly what gets saved, the reference never blends into them.
            let shown = v;
            if (showRef && v === 255) {
                shown = Math.round(255 - (255 - ref.pixels[i]) * refAlpha);
            }
            imageData.data[i * 4] = shown;
            imageData.data[i * 4 + 1] = shown;
            imageData.data[i * 4 + 2] = shown;
            imageData.data[i * 4 + 3] = 255;
        }
        offCtx.putImageData(imageData, 0, 0);

        canvas.width = state.width;
        canvas.height = state.height;
        canvas.style.width = `${state.width * zoom}px`;
        canvas.style.height = `${state.height * zoom}px`;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(offscreen, 0, 0);

        if (overlay && overlay.type === 'rect') {
            const x = Math.min(overlay.x0, overlay.x1);
            const y = Math.min(overlay.y0, overlay.y1);
            const w = Math.abs(overlay.x1 - overlay.x0);
            const h = Math.abs(overlay.y1 - overlay.y0);
            ctx.strokeStyle = '#ff4040';
            ctx.lineWidth = 1 / zoom;
            ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        } else if (overlay && overlay.type === 'line') {
            ctx.strokeStyle = '#ff4040';
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            ctx.moveTo(overlay.x0, overlay.y0);
            ctx.lineTo(overlay.x1, overlay.y1);
            ctx.stroke();
        } else if (overlay && overlay.type === 'polygon') {
            ctx.strokeStyle = '#ff4040';
            ctx.fillStyle = '#ff4040';
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            overlay.points.forEach((p, i) => {
                const px = p.x, py = p.y;
                if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
            });
            if (overlay.cursor) { ctx.lineTo(overlay.cursor.x, overlay.cursor.y); }
            ctx.stroke();
            for (const p of overlay.points) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, 3 / zoom, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    function rerenderFromEdits() {
        livePixels = computePixels();
        render(livePixels);
    }

    function canvasToImageCoords(evt) {
        const rect = canvas.getBoundingClientRect();
        const x = ((evt.clientX - rect.left) / rect.width) * state.width;
        const y = ((evt.clientY - rect.top) / rect.height) * state.height;
        return { x, y };
    }

    function samplePixel(point) {
        const x = Math.max(0, Math.min(state.width - 1, Math.floor(point.x)));
        const y = Math.max(0, Math.min(state.height - 1, Math.floor(point.y)));
        const pixels = computePixels();
        setPct(Math.round((pixels[y * state.width + x] / 255) * 100));
    }

    function addPointWithInterpolation(points, from, to, thickness) {
        if (!from) { points.push(to); return; }
        const dx = to.x - from.x, dy = to.y - from.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const step = Math.max(1, thickness / 4);
        const steps = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= steps; i++) {
            points.push({ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps });
        }
    }

    // --- tool UI: show only what the active tool needs --------------------------------------
    function updateToolUI() {
        const tool = currentTool();
        thicknessWrap.style.display = (tool === 'brush' || tool === 'eraser' || tool === 'line') ? '' : 'none';
        if (tool !== 'select') {
            selectedEditIndex = -1;
            moveStart = null;
            moveOriginal = null;
        }
        // Switching tools mid-polygon abandons it rather than leaving an orphaned partial shape.
        if (tool !== 'polygon' && polygonPoints.length) {
            polygonPoints = [];
            polygonCursor = null;
            if (state) { rerenderFromEdits(); }
        }
    }

    // --- mouse handling -----------------------------------------------------------------------
    canvas.addEventListener('mousedown', (evt) => {
        if (!state) { return; }
        const tool = currentTool();
        const point = canvasToImageCoords(evt);

        if (tool === 'select') {
            selectedEditIndex = findEditAtPoint(point);
            if (selectedEditIndex >= 0) {
                moveStart = point;
                moveOriginal = state.edits[selectedEditIndex];
                livePixels = computePixels();
                render(livePixels);
            }
            return;
        }

        if (tool === 'eyedropper') {
            samplePixel(point);
            return;
        }

        if (tool === 'polygon') {
            polygonPoints.push(point);
            render(livePixels ?? computePixels(), { type: 'polygon', points: polygonPoints, cursor: point });
            return;
        }

        if (tool === 'rect') {
            rectStart = point;
            livePixels = computePixels();
            render(livePixels, { type: 'rect', x0: point.x, y0: point.y, x1: point.x, y1: point.y });
            return;
        }

        if (tool === 'line') {
            lineStart = point;
            livePixels = computePixels();
            render(livePixels, { type: 'line', x0: point.x, y0: point.y, x1: point.x, y1: point.y });
            return;
        }

        // brush / eraser
        const grayValue = tool === 'eraser' ? 255 : currentGrayValue();
        const thickness = Number(thicknessInput.value);
        currentStroke = { type: 'stroke', grayValue, thickness, overlay: overlayMode.checked, points: [point] };
        lastPoint = point;
        livePixels = computePixels();
        applyEdit(livePixels, state.width, state.height, currentStroke);
        render(livePixels);
    });

    canvas.addEventListener('mousemove', (evt) => {
        if (!state) { return; }
        const point = canvasToImageCoords(evt);

        if (moveStart && moveOriginal && selectedEditIndex >= 0) {
            const dx = point.x - moveStart.x;
            const dy = point.y - moveStart.y;
            render(computePixelsWithMovedEdit(selectedEditIndex, translateEdit(moveOriginal, dx, dy)));
            return;
        }

        if (currentTool() === 'polygon' && polygonPoints.length) {
            polygonCursor = point;
            render(livePixels ?? computePixels(), { type: 'polygon', points: polygonPoints, cursor: point });
            return;
        }
        if (rectStart) {
            render(livePixels, { type: 'rect', x0: rectStart.x, y0: rectStart.y, x1: point.x, y1: point.y });
            return;
        }
        if (lineStart) {
            render(livePixels, { type: 'line', x0: lineStart.x, y0: lineStart.y, x1: point.x, y1: point.y });
            return;
        }
        if (!currentStroke) { return; }
        addPointWithInterpolation(currentStroke.points, lastPoint, point, currentStroke.thickness);
        lastPoint = point;
        applyEdit(livePixels, state.width, state.height, {
            type: 'stroke',
            grayValue: currentStroke.grayValue,
            thickness: currentStroke.thickness,
            overlay: currentStroke.overlay,
            points: currentStroke.points.slice(-8), // only the newest segment needs re-stamping
        });
        render(livePixels);
    });

    function finishStroke() {
        if (!currentStroke) { return; }
        vscode.postMessage({ type: 'stroke', ...currentStroke });
        state.edits = [...state.edits, currentStroke];
        currentStroke = null;
        lastPoint = null;
    }

    function finishRect(point) {
        if (!rectStart) { return; }
        const edit = { type: 'rect', grayValue: currentGrayValue(), overlay: overlayMode.checked,
            x0: rectStart.x, y0: rectStart.y, x1: point.x, y1: point.y };
        vscode.postMessage({ type: 'rect', ...edit });
        state.edits = [...state.edits, edit];
        rectStart = null;
        rerenderFromEdits();
    }

    function finishLine(point) {
        if (!lineStart) { return; }
        const thickness = Number(thicknessInput.value);
        const points = [];
        addPointWithInterpolation(points, lineStart, point, thickness);
        const edit = { type: 'stroke', grayValue: currentGrayValue(), thickness,
            overlay: overlayMode.checked, points };
        vscode.postMessage({ type: 'stroke', ...edit });
        state.edits = [...state.edits, edit];
        lineStart = null;
        rerenderFromEdits();
    }

    function finishMove(point) {
        if (!moveStart || !moveOriginal || selectedEditIndex < 0) { return; }
        const dx = point.x - moveStart.x;
        const dy = point.y - moveStart.y;
        if (dx !== 0 || dy !== 0) {
            vscode.postMessage({ type: 'move', index: selectedEditIndex, dx, dy });
            state.edits = state.edits.map((edit, index) =>
                index === selectedEditIndex ? translateEdit(edit, dx, dy) : edit);
        }
        selectedEditIndex = -1;
        moveStart = null;
        moveOriginal = null;
        rerenderFromEdits();
    }

    function closePolygon() {
        if (polygonPoints.length < 3) {
            polygonPoints = [];
            polygonCursor = null;
            if (state) { rerenderFromEdits(); }
            return;
        }
        const edit = { type: 'polygon', grayValue: currentGrayValue(), overlay: overlayMode.checked,
            points: polygonPoints };
        vscode.postMessage({ type: 'polygon', ...edit });
        state.edits = [...state.edits, edit];
        polygonPoints = [];
        polygonCursor = null;
        rerenderFromEdits();
    }

    function cancelPolygon() {
        polygonPoints = [];
        polygonCursor = null;
        if (state) { rerenderFromEdits(); }
    }

    window.addEventListener('mouseup', (evt) => {
        if (!state) { return; }
        const point = canvasToImageCoords(evt);
        if (moveStart) { finishMove(point); return; }
        if (rectStart) { finishRect(point); return; }
        if (lineStart) { finishLine(point); return; }
        finishStroke();
    });
    canvas.addEventListener('mouseleave', () => {
        if (currentStroke) { finishStroke(); }
        // Rectangle/line drags and in-progress polygons deliberately survive the cursor briefly
        // leaving the canvas - that's a normal motion when sizing a zone against the image edge.
    });
    canvas.addEventListener('dblclick', (evt) => {
        if (currentTool() !== 'polygon') { return; }
        evt.preventDefault();
        // The second click of this dblclick already added a (redundant) vertex via mousedown;
        // drop it before closing with whatever vertices were placed deliberately.
        polygonPoints.pop();
        closePolygon();
    });
    window.addEventListener('keydown', (evt) => {
        // Ctrl+Z / Cmd+Z = undo, Ctrl+Y / Cmd+Y = redo. Handled explicitly here (rather than
        // relying on the host window's own keybindings) because the webview's content is a
        // separate browsing context that VS Code's keybinding service doesn't reach into.
        const mod = evt.ctrlKey || evt.metaKey;
        const key = evt.key.toLowerCase();
        if (mod && key === 'z' && !evt.shiftKey) {
            evt.preventDefault();
            vscode.postMessage({ type: 'undo' });
            return;
        }
        if (mod && key === 'y') {
            evt.preventDefault();
            vscode.postMessage({ type: 'redo' });
            return;
        }
        if (currentTool() !== 'polygon' || !polygonPoints.length) { return; }
        if (evt.key === 'Enter') { evt.preventDefault(); closePolygon(); }
        else if (evt.key === 'Escape') { evt.preventDefault(); cancelPolygon(); }
    });

    thicknessInput.addEventListener('input', () => { thicknessLabel.textContent = thicknessInput.value; });
    zoomInput.addEventListener('input', () => {
        zoom = Number(zoomInput.value);
        zoomLabel.textContent = `${zoom}x`;
        if (state) { rerenderFromEdits(); }
    });
    canvasWrap.addEventListener('wheel', (evt) => {
        if (!evt.ctrlKey || !state) { return; }
        evt.preventDefault();
        evt.stopPropagation();
        const canvasRect = canvas.getBoundingClientRect();
        const wrapRect = canvasWrap.getBoundingClientRect();
        const imageX = ((evt.clientX - canvasRect.left) / canvasRect.width) * state.width;
        const imageY = ((evt.clientY - canvasRect.top) / canvasRect.height) * state.height;
        const canvasOffsetX = canvasRect.left - wrapRect.left + canvasWrap.scrollLeft;
        const canvasOffsetY = canvasRect.top - wrapRect.top + canvasWrap.scrollTop;
        const nextZoom = Math.max(1, Math.min(16, zoom + (evt.deltaY < 0 ? 0.5 : -0.5)));
        if (nextZoom === zoom) { return; }
        zoomInput.value = String(nextZoom);
        zoomInput.dispatchEvent(new Event('input'));
        canvasWrap.scrollLeft = canvasOffsetX + imageX * nextZoom - (evt.clientX - wrapRect.left);
        canvasWrap.scrollTop = canvasOffsetY + imageY * nextZoom - (evt.clientY - wrapRect.top);
    }, { passive: false });
    referenceToggle.addEventListener('change', () => { if (state) { rerenderFromEdits(); } });
    referenceOpacity.addEventListener('input', () => { if (state) { rerenderFromEdits(); } });

    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
            case 'init':
                state = {
                    width: message.width,
                    height: message.height,
                    maxval: message.maxval,
                    original: Uint8ClampedArray.from(message.pixels),
                    edits: message.edits ?? [],
                    reference: message.reference
                        ? { width: message.reference.width, height: message.reference.height,
                            pixels: Uint8ClampedArray.from(message.reference.pixels) }
                        : null,
                };
                referenceToggleWrap.style.display = state.reference ? '' : 'none';
                setPct(0);
                updateToolUI();
                rerenderFromEdits();
                break;
            case 'update':
                if (state) {
                    state.edits = message.edits ?? [];
                    rerenderFromEdits();
                }
                break;
        }
    });

    updateToolUI();
    vscode.postMessage({ type: 'ready' });
}());
