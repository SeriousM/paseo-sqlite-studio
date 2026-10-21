// Checks the listing images without any dependency: decodes the PNGs in assets/
// and asserts they are real captures rather than blank or duplicated frames.
//
// Usage: node tools/check-media.mjs [directory]
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";

const CHANNELS_BY_COLOUR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes) {
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error("missing IHDR");
  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new Error(`unsupported PNG: bit depth ${header.bitDepth}, interlace ${header.interlace}`);
  }
  const channels = CHANNELS_BY_COLOUR_TYPE[header.colourType];
  if (!channels) throw new Error(`unsupported colour type ${header.colourType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  let previous = Buffer.alloc(stride);

  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const target = pixels.subarray(row * stride, (row + 1) * stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? target[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      const value = source[index];
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + Math.floor((left + up) / 2);
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);
          result = value + (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unknown filter ${filter}`);
      }
      target[index] = result & 0xff;
    }
    previous = target;
  }

  return { ...header, channels, pixels };
}

function statistics(image) {
  const { width, height, channels, pixels } = image;
  const counts = new Map();
  let luminanceSum = 0;
  let luminanceSquared = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const index = y * width * channels + x * channels;
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? red;
      const blue = pixels[index + 2] ?? red;
      const key = (red << 16) | (green << 8) | blue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      luminanceSum += luminance;
      luminanceSquared += luminance * luminance;
      samples += 1;
    }
  }
  const mean = luminanceSum / samples;
  const variance = luminanceSquared / samples - mean * mean;
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  const dominantKey = dominant?.[0] ?? 0;
  return {
    distinctColours: counts.size,
    meanLuminance: Math.round(mean * 100) / 100,
    standardDeviation: Math.round(Math.sqrt(Math.max(0, variance)) * 100) / 100,
    dominantColour: `#${dominantKey.toString(16).padStart(6, "0")}`,
    dominantShare: Math.round(((dominant?.[1] ?? 0) / samples) * 1000) / 10,
  };
}

function halfDifference(image) {
  const { width, height, channels, pixels } = image;
  let total = 0;
  let samples = 0;
  const middle = Math.floor(width / 2);
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < middle; x += 4) {
      const left = y * width * channels + x * channels;
      const right = y * width * channels + (x + middle) * channels;
      total += Math.abs((pixels[left] ?? 0) - (pixels[right] ?? 0));
      samples += 1;
    }
  }
  return Math.round((total / samples) * 100) / 100;
}

function pairDifference(first, second) {
  if (first.width !== second.width || first.height !== second.height) return Number.NaN;
  const channels = Math.min(first.channels, second.channels);
  let total = 0;
  let samples = 0;
  for (let y = 0; y < first.height; y += 4) {
    for (let x = 0; x < first.width; x += 4) {
      const left = y * first.width * first.channels + x * first.channels;
      const right = y * second.width * second.channels + x * second.channels;
      for (let channel = 0; channel < channels; channel += 1) {
        total += Math.abs((first.pixels[left + channel] ?? 0) - (second.pixels[right + channel] ?? 0));
        samples += 1;
      }
    }
  }
  return Math.round((total / samples) * 100) / 100;
}

const directory = resolve(process.argv[2] ?? "assets");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".png"))
  .sort();
if (files.length === 0) {
  console.error(`no PNG files in ${directory}`);
  process.exit(1);
}

const failures = [];
const decoded = [];
for (const name of files) {
  const image = decodePng(readFileSync(join(directory, name)));
  const stats = statistics(image);
  decoded.push({ name, image });
  const problems = [];
  if (stats.distinctColours < 200) problems.push(`only ${stats.distinctColours} distinct colours (looks blank or flat)`);
  if (stats.standardDeviation < 8) problems.push(`luminance standard deviation ${stats.standardDeviation} is too flat`);
  if (stats.dominantShare > 92) problems.push(`one colour covers ${stats.dominantShare}% of the image`);
  console.log(
    `${name}: ${image.width}x${image.height} colours=${stats.distinctColours} mean=${stats.meanLuminance} sd=${stats.standardDeviation} dominant=${stats.dominantColour} (${stats.dominantShare}%)`,
  );
  if (problems.length > 0) failures.push(`${name}: ${problems.join("; ")}`);
}

for (let index = 0; index < decoded.length; index += 1) {
  for (let other = index + 1; other < decoded.length; other += 1) {
    const difference = pairDifference(decoded[index].image, decoded[other].image);
    console.log(`${decoded[index].name} vs ${decoded[other].name}: mean channel difference ${difference}`);
    if (!(difference > 3)) {
      failures.push(`${decoded[index].name} and ${decoded[other].name} look like the same frame (difference ${difference})`);
    }
  }
}

for (const { name, image } of decoded) {
  const difference = halfDifference(image);
  console.log(`${name}: left/right half difference ${difference}`);
  if (!(difference > 1)) failures.push(`${name}: both halves are identical, so no content is visible`);
}

if (failures.length > 0) {
  console.error("\nmedia checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("\nall media checks passed");
