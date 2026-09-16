# Change Log

All notable changes to the "PGM Editor" extension will be documented in this file.

## [0.0.1] - 2026-06-28

### Initial Release

#### Features
- **Custom editor** for `.pgm` (P5 binary grayscale) files - opens directly, no PNG round-trip
- **Polygon, Line, Rectangle, Brush, Eraser, Eye Dropper** tools - polygon and rectangle auto-fill; eye dropper samples a pixel's grayscale value
- **Gray % / Speed % sliders**, bidirectionally linked using Nav2's `speed_mask.pgm` scale formula
- **Overlay mode** checkbox - painting only replaces lighter pixels, preserving darker shades
- **Map reference overlay** - auto-detects and faintly shows the real map under a `filters/*.pgm` mask
- **Zoom** up to 16x with nearest-neighbor scaling
- **Undo / redo** via Ctrl+Z / Ctrl+Y (Cmd+Z / Cmd+Y on Mac), a whole shape at a time

#### Technical Details
- TypeScript `CustomEditorProvider` with full undo/redo integration via `CustomDocumentEditEvent`
- Hand-rolled PGM (P5) parser/serializer - reads and writes raw pixel bytes directly
- Webview styled with VS Code's own theme variables and the `@vscode/codicons` icon font
