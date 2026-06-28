import * as vscode from 'vscode';
import { parsePgm, serializePgm, PgmImage } from './pgmIO';

interface StrokeEdit {
    type: 'stroke';
    grayValue: number;
    thickness: number;
    /** Stamp centers, already densely sampled by the webview - no interpolation needed here. */
    points: { x: number; y: number }[];
}

interface RectEdit {
    type: 'rect';
    grayValue: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

interface PolygonEdit {
    type: 'polygon';
    grayValue: number;
    /** Vertices in order; the closing edge (last -> first) is implicit. */
    points: { x: number; y: number }[];
}

type Edit = StrokeEdit | RectEdit | PolygonEdit;

/** Standard scanline fill, even-odd rule. Samples at pixel centers (y+0.5) to avoid the classic
 * double-crossing bug when an edge passes exactly through an integer scanline. */
function fillPolygon(pixels: Uint8Array, width: number, height: number, edit: PolygonEdit): void {
    const pts = edit.points;
    if (pts.length < 3) {
        return;
    }
    const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));

    for (let y = minY; y <= maxY; y++) {
        const yc = y + 0.5;
        const xs: number[] = [];
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
                pixels[y * width + x] = edit.grayValue;
            }
        }
    }
}

/** Mutates pixels in place. */
function applyEdit(pixels: Uint8Array, width: number, height: number, edit: Edit): void {
    if (edit.type === 'polygon') {
        fillPolygon(pixels, width, height, edit);
        return;
    }

    if (edit.type === 'rect') {
        const minX = Math.max(0, Math.floor(Math.min(edit.x0, edit.x1)));
        const maxX = Math.min(width - 1, Math.ceil(Math.max(edit.x0, edit.x1)));
        const minY = Math.max(0, Math.floor(Math.min(edit.y0, edit.y1)));
        const maxY = Math.min(height - 1, Math.ceil(Math.max(edit.y0, edit.y1)));
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                pixels[y * width + x] = edit.grayValue;
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
                const dx = x - cx;
                const dy = y - cy;
                if (dx * dx + dy * dy <= r2) {
                    pixels[y * width + x] = edit.grayValue;
                }
            }
        }
    }
}

function applyAllEdits(original: Uint8Array, width: number, height: number, edits: Edit[]): Uint8Array {
    // new Uint8Array(original) always copies, even if original is secretly a Node Buffer (whose
    // own .slice() override aliases memory instead of copying it - see pgmIO.ts's parsePgm for
    // why that matters here: this must never mutate the pristine original backing _original.data.
    const pixels = new Uint8Array(original);
    for (const edit of edits) {
        applyEdit(pixels, width, height, edit);
    }
    return pixels;
}

type PgmRole =
    | { kind: 'filter'; mapUri: vscode.Uri }  // .../<name>/filters/<mask>.pgm
    | { kind: 'staticMap' }                   // .../<name>/map.pgm (has a sibling 'filters' dir)
    | { kind: 'unknown' };                    // doesn't follow the Nav2 maps/<name> convention

/**
 * Classifies a .pgm purely by its location, mirroring the Nav2 convention directly: a file
 * inside a directory named 'filters' is a filter mask (and the map it overlays is one level
 * above that 'filters' directory); a file one level above a sibling 'filters' directory is the
 * static map itself, with nothing to overlay it with.
 */
async function classifyPgm(uri: vscode.Uri): Promise<PgmRole> {
    const segments = uri.path.split('/').filter(Boolean);
    const parentDirName = segments[segments.length - 2];
    if (parentDirName === 'filters') {
        return { kind: 'filter', mapUri: vscode.Uri.joinPath(uri, '..', '..', 'map.pgm') };
    }
    try {
        const siblingFilters = await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, '..', 'filters'));
        if (siblingFilters.type & vscode.FileType.Directory) {
            return { kind: 'staticMap' };
        }
    } catch {
        // no sibling 'filters' directory - falls through to 'unknown'
    }
    return { kind: 'unknown' };
}

/**
 * Best-effort lookup of the real map a filter mask overlays, for use as a faint visual
 * reference while painting. Only used if dimensions match exactly - registering mismatched
 * resolution/origin is out of scope for a reference guide. Static maps and anything outside
 * the maps/<name> convention have nothing to reference against.
 */
async function loadReferenceMap(uri: vscode.Uri, width: number, height: number):
    Promise<{ width: number; height: number; pixels: Uint8Array } | null> {
    const role = await classifyPgm(uri);
    if (role.kind !== 'filter') {
        return null;
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(role.mapUri);
        const image = parsePgm(bytes);
        if (image.width !== width || image.height !== height || !(image.data instanceof Uint8Array)) {
            return null;
        }
        return { width: image.width, height: image.height, pixels: image.data };
    } catch {
        return null;
    }
}

const EDIT_LABELS: Record<Edit['type'], string> = {
    stroke: 'Freehand stroke',
    rect: 'Rectangle fill',
    polygon: 'Polygon fill',
};

class PgmDocument implements vscode.CustomDocument {
    static async create(uri: vscode.Uri): Promise<PgmDocument> {
        const fileData = await vscode.workspace.fs.readFile(uri);
        const image = parsePgm(fileData);
        if (!(image.data instanceof Uint8Array)) {
            throw new Error('Only 8-bit (maxval < 256) PGM images are supported by this editor.');
        }
        const reference = await loadReferenceMap(uri, image.width, image.height);
        return new PgmDocument(uri, image as PgmImage & { data: Uint8Array }, reference);
    }

    private readonly _uri: vscode.Uri;
    private readonly _original: PgmImage & { data: Uint8Array };
    private readonly _reference: { width: number; height: number; pixels: Uint8Array } | null;
    private _edits: Edit[] = [];
    private _savedEditCount = 0;

    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    readonly onDidDispose = this._onDidDispose.event;

    private readonly _onDidChangeDocument = new vscode.EventEmitter<{
        readonly content?: Edit[];
    }>();
    /** Fired after every edit/undo/redo so the webview can re-render. */
    readonly onDidChangeContent = this._onDidChangeDocument.event;

    private readonly _onDidChangeForEditing = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PgmDocument>>();
    readonly onDidChangeDocumentForEditing = this._onDidChangeForEditing.event;

    private constructor(
        uri: vscode.Uri,
        original: PgmImage & { data: Uint8Array },
        reference: { width: number; height: number; pixels: Uint8Array } | null,
    ) {
        this._uri = uri;
        this._original = original;
        this._reference = reference;
    }

    get uri() { return this._uri; }
    get width() { return this._original.width; }
    get height() { return this._original.height; }
    get maxval() { return this._original.maxval; }
    get edits() { return this._edits; }
    get reference() { return this._reference; }
    /** Pixel data as last loaded from disk, with no edits applied. */
    get originalPixels() { return this._original.data; }

    /** Current pixel data with all edits applied. */
    get currentPixels(): Uint8Array {
        return applyAllEdits(this._original.data, this.width, this.height, this._edits);
    }

    get isDirty(): boolean {
        return this._edits.length !== this._savedEditCount;
    }

    addEdit(edit: Edit): void {
        const editsBeforeThis = this._edits;
        this._edits = [...this._edits, edit];

        this._onDidChangeForEditing.fire({
            document: this,
            label: EDIT_LABELS[edit.type],
            undo: async () => {
                this._edits = editsBeforeThis;
                this._onDidChangeDocument.fire({ content: this._edits });
            },
            redo: async () => {
                this._edits = [...editsBeforeThis, edit];
                this._onDidChangeDocument.fire({ content: this._edits });
            },
        });
        this._onDidChangeDocument.fire({ content: this._edits });
    }

    async save(cancellation: vscode.CancellationToken): Promise<void> {
        await this.saveAs(this._uri, cancellation);
        this._savedEditCount = this._edits.length;
    }

    async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        const bytes = serializePgm({
            width: this.width,
            height: this.height,
            maxval: this.maxval,
            data: this.currentPixels,
        });
        if (cancellation.isCancellationRequested) {
            return;
        }
        await vscode.workspace.fs.writeFile(targetResource, bytes);
    }

    async revert(_cancellation: vscode.CancellationToken): Promise<void> {
        const fileData = await vscode.workspace.fs.readFile(this._uri);
        const image = parsePgm(fileData);
        (this._original as PgmImage).data = image.data;
        this._edits = [];
        this._savedEditCount = 0;
        this._onDidChangeDocument.fire({ content: this._edits });
    }

    async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        await this.saveAs(destination, cancellation);
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(destination);
                } catch {
                    // best-effort cleanup
                }
            },
        };
    }

    dispose(): void {
        this._onDidDispose.fire();
    }
}

export class PgmEditorProvider implements vscode.CustomEditorProvider<PgmDocument> {
    private static readonly viewType = 'pgmEditor.editor';

    private readonly webviews = new Map<string, Set<vscode.WebviewPanel>>();

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new PgmEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(PgmEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PgmDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) { }

    async openCustomDocument(uri: vscode.Uri): Promise<PgmDocument> {
        const document = await PgmDocument.create(uri);

        document.onDidChangeDocumentForEditing((e) => this._onDidChangeCustomDocument.fire(e));
        document.onDidChangeContent((e) => {
            for (const panel of this.webviews.get(uri.toString()) ?? []) {
                panel.webview.postMessage({ type: 'update', edits: e.content ?? [] });
            }
        });

        return document;
    }

    async resolveCustomEditor(document: PgmDocument, panel: vscode.WebviewPanel): Promise<void> {
        const key = document.uri.toString();
        if (!this.webviews.has(key)) {
            this.webviews.set(key, new Set());
        }
        this.webviews.get(key)!.add(panel);
        panel.onDidDispose(() => this.webviews.get(key)?.delete(panel));

        panel.webview.options = { enableScripts: true };
        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage((message) => {
            switch (message.type) {
                case 'ready':
                    panel.webview.postMessage({
                        type: 'init',
                        width: document.width,
                        height: document.height,
                        maxval: document.maxval,
                        pixels: Array.from(document.originalPixels),
                        edits: document.edits,
                        reference: document.reference
                            ? { width: document.reference.width, height: document.reference.height,
                                pixels: Array.from(document.reference.pixels) }
                            : null,
                    });
                    break;
                case 'stroke':
                    document.addEdit({
                        type: 'stroke',
                        grayValue: message.grayValue,
                        thickness: message.thickness,
                        points: message.points,
                    });
                    break;
                case 'rect':
                    document.addEdit({
                        type: 'rect',
                        grayValue: message.grayValue,
                        x0: message.x0,
                        y0: message.y0,
                        x1: message.x1,
                        y1: message.y1,
                    });
                    break;
                case 'polygon':
                    document.addEdit({
                        type: 'polygon',
                        grayValue: message.grayValue,
                        points: message.points,
                    });
                    break;
                case 'undo':
                    vscode.commands.executeCommand('undo');
                    break;
                case 'redo':
                    vscode.commands.executeCommand('redo');
                    break;
            }
        });
    }

    saveCustomDocument(document: PgmDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.save(cancellation);
    }

    saveCustomDocumentAs(document: PgmDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.saveAs(destination, cancellation);
    }

    revertCustomDocument(document: PgmDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return document.revert(cancellation);
    }

    backupCustomDocument(
        document: PgmDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken,
    ): Thenable<vscode.CustomDocumentBackup> {
        return document.backup(context.destination, cancellation);
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pgmEditor.js'));
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pgmEditor.css'));
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(
            this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
    <link href="${codiconUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>PGM Editor</title>
</head>
<body>
    <div class="toolbar">
        <span class="select-wrap">
            <select id="tool" class="tool-select">
                <option value="polygon" title="Click to add points · double-click or Enter to close &amp; fill · Escape to cancel">Polygon</option>
                <option value="line">Line</option>
                <option value="rect">Rectangle</option>
                <option value="brush">Brush</option>
                <option value="eraser">Eraser</option>
            </select>
        </span>

        <span class="sep"></span>

        <div class="zone">
            <span class="swatch" id="colorSwatch"></span>
            <label>Gray %
                <input id="grayValue" type="range" min="0" max="100" value="0" class="slider slider-gray">
                <span id="grayValueLabel" class="value">0</span>
            </label>
            <label title="Only meaningful for speed_mask.pgm with base=100/multiplier=-1 (this project's config). Ignore for keepout_mask.pgm.">Speed %
                <input id="speedPct" type="range" min="0" max="100" value="100" class="slider slider-speed">
                <span id="speedPctLabel" class="value">100</span>
            </label>
            <span id="thicknessWrap">
                <label>Thickness
                    <input id="thickness" type="range" min="1" max="40" value="4" class="slider">
                    <span id="thicknessLabel" class="value">4</span>
                </label>
            </span>
        </div>

        <span class="sep"></span>

        <div class="zone">
            <label title="Zoom">
                <i class="codicon codicon-zoom-in" aria-hidden="true"></i>
                <input id="zoomLevel" type="range" min="1" max="16" value="4" class="slider" aria-label="Zoom level">
                <span id="zoomLabel" class="value">4x</span>
            </label>
            <span id="referenceToggleWrap" style="display:none">
                <label><input id="referenceToggle" type="checkbox" checked>
                    <i class="codicon codicon-map" aria-hidden="true"></i> Map ref</label>
                <input id="referenceOpacity" type="range" min="0" max="100" value="40" class="slider" title="Reference opacity">
            </span>
        </div>
    </div>
    <div class="canvas-wrap">
        <canvas id="canvas"></canvas>
    </div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
