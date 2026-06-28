/**
 * Minimal PGM (P5, binary grayscale) reader/writer.
 * P5 header: "P5\n<width> <height>\n<maxval>\n" followed by raw pixel bytes
 * (1 byte/pixel for maxval < 256, 2 bytes/pixel big-endian otherwise),
 * with '#' comments allowed between header tokens.
 */

export interface PgmImage {
    width: number;
    height: number;
    maxval: number;
    /** One entry per pixel, row-major, top-to-bottom. Values are 0..maxval. */
    data: Uint8Array | Uint16Array;
}

class TokenReader {
    private pos = 0;
    constructor(private readonly bytes: Uint8Array) { }

    /** Read the next whitespace-delimited token, skipping '#' comments. */
    nextToken(): string {
        // Skip whitespace and comments.
        while (this.pos < this.bytes.length) {
            const c = this.bytes[this.pos];
            if (c === 0x23 /* '#' */) {
                while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a) {
                    this.pos++;
                }
            } else if (isWhitespace(c)) {
                this.pos++;
            } else {
                break;
            }
        }
        const start = this.pos;
        while (this.pos < this.bytes.length && !isWhitespace(this.bytes[this.pos])) {
            this.pos++;
        }
        return Buffer.from(this.bytes.slice(start, this.pos)).toString('ascii');
    }

    /** Position immediately after the single whitespace byte that follows maxval. */
    get binaryStart(): number {
        return this.pos + 1;
    }
}

function isWhitespace(c: number): boolean {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;
}

export function parsePgm(bytes: Uint8Array): PgmImage {
    const reader = new TokenReader(bytes);

    const magic = reader.nextToken();
    if (magic !== 'P5') {
        throw new Error(`Not a binary PGM (P5) file - found magic number "${magic}"`);
    }
    const width = parseInt(reader.nextToken(), 10);
    const height = parseInt(reader.nextToken(), 10);
    const maxval = parseInt(reader.nextToken(), 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(maxval)) {
        throw new Error('Malformed PGM header');
    }

    const pixelCount = width * height;
    const bytesPerPixel = maxval < 256 ? 1 : 2;
    const start = reader.binaryStart;
    const end = start + pixelCount * bytesPerPixel;
    if (end > bytes.length) {
        throw new Error('PGM file is truncated - not enough pixel data for its declared dimensions');
    }

    if (bytesPerPixel === 1) {
        // bytes may be a Node Buffer in some callers (e.g. fs.readFileSync) - Buffer IS a
        // Uint8Array (passes any type check) but overrides .slice()/.subarray() to alias
        // memory instead of copying it, AND (confirmed directly - this is not obvious from the
        // spec) %TypedArray%.prototype.slice.call(buffer, ...) still produces a Buffer-typed
        // result via species-constructor lookup on `this`, even though that particular result
        // happens to hold independent bytes - any *later* naive .slice() on it would alias
        // again. `new Uint8Array(length)` + a manual copy loop is the only approach that's
        // guaranteed to produce a true Uint8Array, immune to this regardless of what bytes is.
        const data = new Uint8Array(end - start);
        for (let i = 0; i < data.length; i++) {
            data[i] = bytes[start + i];
        }
        return { width, height, maxval, data };
    }

    const data = new Uint16Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        const offset = start + i * 2;
        data[i] = (bytes[offset] << 8) | bytes[offset + 1]; // big-endian, per PGM spec
    }
    return { width, height, maxval, data };
}

export function serializePgm(image: PgmImage): Uint8Array {
    const header = Buffer.from(`P5\n${image.width} ${image.height}\n${image.maxval}\n`, 'ascii');
    const bytesPerPixel = image.maxval < 256 ? 1 : 2;

    if (bytesPerPixel === 1) {
        const body = image.data instanceof Uint8Array
            ? image.data
            : Uint8Array.from(image.data, (v) => v & 0xff);
        return Buffer.concat([header, Buffer.from(body)]);
    }

    const body = Buffer.alloc(image.data.length * 2);
    for (let i = 0; i < image.data.length; i++) {
        const v = image.data[i];
        body[i * 2] = (v >> 8) & 0xff;
        body[i * 2 + 1] = v & 0xff;
    }
    return Buffer.concat([header, body]);
}
