# PGM Editor

[![Version](https://img.shields.io/badge/version-0.0.1-green)](https://github.com/adityakamath/pgm_editor)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Note**: This extension was vibe-coded with [Claude](https://claude.ai) for personal use while painting Nav2 keepout/speed zones, and made public in case it's useful to anyone else. Contributions and feedback are welcome!

A minimal VS Code custom editor for painting directly on P5 (binary
grayscale) PGM images - no PNG round-trip needed. Built for editing
[Nav2 costmap filter masks](https://docs.nav2.org/tutorials/docs/navigation2_with_keepout_filter.html)
(keepout/speed zones), but works on any 8-bit PGM.

## Features

🔺 **Polygon, Line, Rectangle, Brush, Eraser, Eye Dropper** - closed shapes (polygon)
auto-fill, everything else paints at the chosen thickness

🎨 **Gray % / Speed % sliders** - bidirectionally linked, with the actual
formula for Nav2's `speed_mask.pgm` (`base=100, multiplier=-1`)

🗺️ **Map reference overlay** - automatically finds and faintly shows the
real map underneath a filter mask, so you can see walls/furniture while
painting zones - display-only, never written to the saved file

🔍 **Pixel-precise zoom** - up to 16x, with nearest-neighbor scaling so
masks stay crisp

↩️ **Undo / redo** - Ctrl+Z / Ctrl+Y (Cmd+Z / Cmd+Y on Mac), a whole shape
at a time

⚡ **No PNG round-trip** - reads and writes the actual P5 binary pixels
directly, so nothing about the file (header, resolution, mode) changes
except the pixels you paint

## Installation

This extension isn't published to the VS Code Marketplace - install it
from source.

### Build and install locally

```bash
git clone https://github.com/adityakamath/pgm_editor.git
cd pgm_editor
npm install
npm run compile
ln -s "$(pwd)" ~/.vscode-server/extensions/kamathsblog.pgm-editor-0.0.1
```

(Use `~/.vscode/extensions` instead of `~/.vscode-server/extensions` if
you're not on a Remote-SSH/Server setup.) Then **Ctrl+Shift+P → "Developer:
Reload Window"**. Opening any `.pgm` file now loads directly into the
painter, no separate dev-host window needed. After changing the source,
`npm run compile` + reload window again.

### Alternative: development/debugging mode

Open this folder in VS Code and press F5 - this launches a *separate*
"Extension Development Host" window with the extension loaded, useful for
using the debugger but otherwise more friction than the install above.

## Usage

**Tools** (dropdown):

- **Polygon** (default tool): click to place each vertex, then **double-click
  or Enter** to close and fill the shape, **Escape** to cancel. Handles
  concave shapes correctly (e.g. an L-shaped room).
- **Line**: click-drag a single straight segment at the chosen thickness.
- **Rectangle**: click-drag corner to corner, filled on release.
- **Brush**: freehand painting at the chosen gray value and thickness.
- **Eraser**: same as Brush, but always paints white (255) regardless of the
  Gray % slider - for fixing mistakes without flipping the slider back and
  forth.
- **Eye Dropper**: click any pixel to load its grayscale value into the Gray %
  and Speed % controls without changing the image.
- **Overlay**: when enabled, painting only affects pixels lighter than the
  selected grayscale value; darker pixels are left unchanged.

**Color**:

- **Gray %** slider: 0 (black) to 100 (white). All tools draw in this color
  except Eraser (always white).
- **Speed %** slider: bidirectionally linked to Gray % via
  `speed_% = (gray_value / 255) * 100` - the actual formula for this
  project's `speed_mask.pgm` config (`base=100, multiplier=-1`: white=100%
  speed, black=full stop). For this config Gray % and Speed % are the same
  linear scale, so they always show the same number - Speed % is kept as its
  own control since that's the unit you actually think in when editing
  `speed_mask.pgm`. Ignore it when editing `keepout_mask.pgm` (there, just use
  Gray %: 0 = no-go, 100 = clear, 1-99 = an optional weighted "discouraged but
  passable" zone).

**Everything else**:

- **Thickness**: stamp/line width in pixels (Brush, Eraser, Line only -
  hidden for Polygon/Rectangle, which fill solid).
- **Zoom**: masks are usually small (a few hundred pixels per side) - zoom in
  to paint precisely. Hold Ctrl and scroll over the canvas to zoom in or out.
- **Map reference**: if the file you're editing is
  `maps/<name>/filters/<mask>.pgm`, the sibling `maps/<name>/map.pgm` is
  loaded automatically and shown faintly underneath unpainted (white) areas,
  so you can see walls/furniture while deciding where to paint. Adjustable
  opacity. Only appears when a same-size reference map is actually found.
  Display-only - never written to the saved file.
- **Save**: click the toolbar save button or press Ctrl+S (Cmd+S on Mac) to
  write back to the same `.pgm` file.
- **Undo / Redo**: Ctrl+Z / Ctrl+Y (Cmd+Z / Cmd+Y on Mac) - undo/redo work a
  whole shape at a time.

## Notes

- Only 8-bit PGM (`maxval` < 256) is supported - that covers every mask this
  was built for (Nav2 masks are saved with `maxval: 255`).
- Editing doesn't touch the mask's `.yaml` sidecar (resolution/origin/mode) -
  only the pixel data.
- The map reference lookup only activates when the reference file exists
  *and* matches the mask's pixel dimensions exactly - it doesn't attempt to
  rescale or re-register mismatched resolution/origin.

## Development

### Project Structure

```
pgm_editor/
├── src/
│   ├── extension.ts    # Activation entry point
│   ├── pgmEditor.ts    # Custom editor provider + document/edit model
│   └── pgmIO.ts        # PGM (P5) parser/serializer
├── media/
│   ├── pgmEditor.js    # Webview-side painting/rendering logic
│   ├── pgmEditor.css   # Webview styling
│   ├── codicon.css     # Vendored from @vscode/codicons (devDependency) - toolbar icons
│   └── codicon.ttf     # Vendored from @vscode/codicons (devDependency) - icon font
├── package.json        # Extension manifest
├── tsconfig.json        # TypeScript config
└── README.md            # This file
```

### Running in Debug Mode

1. Open this folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open a `.pgm` file in the new window to test your changes

### Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

- **Issues**: [GitHub Issues](https://github.com/adityakamath/pgm_editor/issues)
- **Nav2 costmap filters**: [keepout filter](https://docs.nav2.org/tutorials/docs/navigation2_with_keepout_filter.html) / [speed filter](https://docs.nav2.org/tutorials/docs/navigation2_with_speed_filter.html) tutorials

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT licensed. See [LICENSE](LICENSE) for details.
