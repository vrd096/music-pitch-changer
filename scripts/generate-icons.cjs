/**
 * Generate placeholder PNG icons for the Chrome extension.
 * Creates simple colored square icons without external dependencies.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.resolve(__dirname, '..', 'public', 'icons');

// CRC32 table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toBytesBE(val, len) {
  const bytes = [];
  for (let i = len - 1; i >= 0; i--) {
    bytes.push((val >> (i * 8)) & 0xff);
  }
  return bytes;
}

function createSimplePNG(width, height, r, g, b) {
  // Create raw RGBA pixel data with filter bytes
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: None
    for (let x = 0; x < width; x++) {
      const cx = width / 2;
      const cy = height / 2;
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let alpha = 0;
      if (dist < 0.85) {
        alpha = 255;
      } else if (dist < 1.0) {
        alpha = Math.round(255 * (1.0 - (dist - 0.85) / 0.15));
      }

      rawData.push(r, g, b, alpha);
    }
  }

  const rawBuf = Buffer.from(rawData);
  const compressed = zlib.deflateSync(rawBuf);

  // Build PNG chunks
  const chunks = [];

  // PNG Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  chunks.push(createChunk('IHDR', ihdr));

  // IDAT
  chunks.push(createChunk('IDAT', compressed));

  // IEND
  chunks.push(createChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const typeBytes = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBytes, data]);
  const crcVal = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function generate() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const icons = [
    { name: 'icon16.png', size: 16 },
    { name: 'icon48.png', size: 48 },
    { name: 'icon128.png', size: 128 },
  ];

  for (const { name, size } of icons) {
    const png = createSimplePNG(size, size, 99, 102, 241);
    fs.writeFileSync(path.join(ICONS_DIR, name), png);
    console.log(`✓ Created ${name} (${size}x${size})`);
  }
}

generate();
