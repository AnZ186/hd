(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AibantoMp4Patcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const AUDIO_MULTIPLIER = 10;
  const SYNTHETIC_AUDIO_SAMPLE = Uint8Array.from([0, 0, 0, 4, 0, 0, 0, 0]);
  const CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst",
  ]);

  function patchAibantoContainer(inputBytes, options = {}) {
    return patchWithReport(inputBytes, options).bytes;
  }

  function patchWithReport(inputBytes, options = {}) {
    const source = toUint8Array(inputBytes);
    const rootBoxes = parseChildren(source, 0, source.byteLength);
    const moov = rootBoxes.find((box) => box.type === "moov");
    if (!moov) throw new Error("MP4 moov atom not found.");
    if (!rootBoxes.some((box) => box.type === "mdat")) throw new Error("MP4 mdat atom not found.");

    const tracks = moov.children
      .filter((box) => box.type === "trak")
      .map((trak, index) => readTrack(source, trak, index));
    
    const videoTrack = tracks.find((track) => track.kind === "vide");
    if (!videoTrack) throw new Error("A video track was not found.");
    
    const audioTrack = tracks.find((track) => track.kind === "soun");
    if (audioTrack && audioTrack.sampleEntryType !== "mp4a") {
      throw new Error(`The audio track uses ${audioTrack.sampleEntryType || "an unknown codec"}; AAC/mp4a is required.`);
    }

    const records = [];
    for (const track of tracks) for (const chunk of track.chunks) records.push({ track, chunk });
    records.sort((left, right) => left.chunk.offset - right.chunk.offset);
    validateChunkRanges(source, rootBoxes, records);

    const chunkParts = [];
    const relativeOffsets = new Map(tracks.map((track) => [track, new Array(track.chunks.length)]));
    let mediaBytes = 0;
    for (const { track, chunk } of records) {
      relativeOffsets.get(track)[chunk.index] = mediaBytes;
      const bytes = source.subarray(chunk.offset, chunk.offset + chunk.byteLength);
      chunkParts.push(bytes);
      mediaBytes += bytes.byteLength;
    }

    const declaredMediaBytes = mediaBytes;
    const realAudioSamples = audioTrack ? audioTrack.sampleSizes.length : 0;
    const syntheticAudioSamples = realAudioSamples * (AUDIO_MULTIPLIER - 1);
    let syntheticBytes = new Uint8Array(0);
    if (audioTrack && syntheticAudioSamples > 0) {
      relativeOffsets.get(audioTrack).push(mediaBytes);
      syntheticBytes = repeatBytes(SYNTHETIC_AUDIO_SAMPLE, syntheticAudioSamples);
      chunkParts.push(syntheticBytes);
      mediaBytes += syntheticBytes.byteLength;
    }

    const tables = new Map();
    for (const track of tracks) {
      const sampleSizes = track === audioTrack && syntheticAudioSamples > 0
        ? [...track.sampleSizes, ...new Array(syntheticAudioSamples).fill(SYNTHETIC_AUDIO_SAMPLE.byteLength)]
        : track.sampleSizes;
      const stscEntries = readStscEntries(source, track.stsc);
      if (track === audioTrack && syntheticAudioSamples > 0) {
        stscEntries.push({
          firstChunk: track.chunks.length + 1,
          samplesPerChunk: syntheticAudioSamples,
          sampleDescriptionIndex: stscEntries[stscEntries.length - 1]?.sampleDescriptionIndex || 1,
        });
      }
      tables.set(track, {
        sampleSizes,
        stscEntries,
        chunkOffsets: new Array(relativeOffsets.get(track).length).fill(0),
      });
    }

    const ftyp = makeFtyp();
    const otherTopLevel = rootBoxes
      .filter((box) => !["ftyp", "moov", "mdat", "free", "skip", "wide"].includes(box.type))
      .map((box) => source.subarray(box.start, box.end));
    const otherBytes = otherTopLevel.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const mdatHeaderSize = declaredMediaBytes + 8 <= 0xffffffff ? 8 : 16;
    const branding = options.branding !== false;
    const audioTiming = audioTrack ? normalizeAudioTiming(source, moov, audioTrack) : null;

    let patchedMoov = rebuildMoov(source, moov, tracks, audioTrack, tables, branding, audioTiming);
    for (let pass = 0; pass < 4; pass += 1) {
      const mdatStart = ftyp.byteLength + patchedMoov.byteLength + otherBytes;
      for (const track of tracks) {
        tables.get(track).chunkOffsets = relativeOffsets.get(track)
          .map((offset) => mdatStart + mdatHeaderSize + offset);
      }
      const nextMoov = rebuildMoov(source, moov, tracks, audioTrack, tables, branding, audioTiming);
      if (nextMoov.byteLength === patchedMoov.byteLength) {
        patchedMoov = nextMoov;
        break;
      }
      patchedMoov = nextMoov;
      if (pass === 3) throw new Error("MP4 chunk offset layout did not converge.");
    }

    const finalMdatStart = ftyp.byteLength + patchedMoov.byteLength + otherBytes;
    for (const track of tracks) {
      tables.get(track).chunkOffsets = relativeOffsets.get(track)
        .map((offset) => finalMdatStart + mdatHeaderSize + offset);
    }
    patchedMoov = rebuildMoov(source, moov, tracks, audioTrack, tables, branding, audioTiming);
    
    const output = concat([
      ftyp,
      patchedMoov,
      ...otherTopLevel,
      makeMdatHeader(declaredMediaBytes, mdatHeaderSize),
      ...chunkParts,
    ]);

    const videoTiming = readMdhd(source, videoTrack.mdhd);
    return {
      bytes: output,
      report: {
        version: "3.0.0",
        videoSampleCount: videoTrack.sampleSizes.length,
        videoTimescale: videoTiming.timescale,
        videoBytesAdded: 0,
        videoBitstreamPreserved: true,
        realAudioSampleCount: realAudioSamples,
        exposedAudioSampleCount: realAudioSamples + syntheticAudioSamples,
        syntheticAudioSampleCount: syntheticAudioSamples,
        syntheticAudioSampleBytes: SYNTHETIC_AUDIO_SAMPLE.byteLength,
        audioMultiplier: AUDIO_MULTIPLIER,
        declaredAudioDurationTicks: audioTiming?.duration || 0,
        branding: branding ? "kryptonaep" : null,
      },
    };
  }

  function readTracks(bytes) {
    const root = parseChildren(bytes, 0, bytes.byteLength);
    const moov = root.find((box) => box.type === "moov");
    if (!moov) throw new Error("MP4 moov atom not found.");
    return moov.children.filter((box) => box.type === "trak").map((box, index) => readTrack(bytes, box, index));
  }

  function readTrack(source, trak, index) {
    const stbl = findBox(trak, ["mdia", "minf", "stbl"]);
    const stsz = findBox(stbl, ["stsz"]);
    const stsc = findBox(stbl, ["stsc"]);
    const chunkOffsetsBox = findBox(stbl, ["stco"]) || findBox(stbl, ["co64"]);
    const stts = findBox(stbl, ["stts"]);
    const mdhd = findBox(trak, ["mdia", "mdhd"]);
    const tkhd = findBox(trak, ["tkhd"]);
    if (!stbl || !stsz || !stsc || !chunkOffsetsBox || !stts || !mdhd || !tkhd) {
      throw new Error(`Track ${index + 1} has incomplete sample tables.`);
    }
    const sampleSizes = readStsz(source, stsz);
    const chunkOffsets = readChunkOffsets(source, chunkOffsetsBox);
    const stscEntries = readStscEntries(source, stsc);
    return {
      index,
      trak,
      kind: getTrackKind(trak, source),
      stbl,
      stsz,
      stsc,
      chunkOffsetsBox,
      stts,
      mdhd,
      tkhd,
      edts: findBox(trak, ["edts"]),
      udta: findBox(trak, ["udta"]),
      sdtp: findBox(stbl, ["sdtp"]),
      avc: findVideoConfig(source, stbl),
      sampleEntryType: readSampleEntryType(source, stbl),
      sampleSizes,
      chunks: expandChunks(sampleSizes, chunkOffsets, stscEntries),
    };
  }

  function findVideoConfig(source, stbl) {
    const stsd = findBox(stbl, ["stsd"]);
    if (!stsd) return null;
    const count = readU32(source, stsd.start + 12);
    let cursor = stsd.start + 16;
    for (let i = 0; i < count; i += 1) {
      if (cursor + 8 > stsd.end) break;
      const size = readU32(source, cursor);
      const type = readType(source, cursor + 4);
      if (size < 8 || cursor + size > stsd.end) break;
      if (type === "avc1" || type === "avc3" || type === "hev1" || type === "hvc1" || type === "mp4v") {
        return { type, lengthSize: 4 };
      }
      cursor += size;
    }
    return null;
  }

  function expandChunks(sampleSizes, offsets, entries) {
    if (!entries.length && offsets.length) throw new Error("stsc has no entries.");
    const chunks = [];
    let sampleIndex = 0;
    let entryIndex = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      const chunkNumber = i + 1;
      while (entryIndex + 1 < entries.length && entries[entryIndex + 1].firstChunk <= chunkNumber) entryIndex += 1;
      const entry = entries[entryIndex];
      if (!entry || entry.firstChunk > chunkNumber || entry.samplesPerChunk < 1) throw new Error("Invalid stsc mapping.");
      if (sampleIndex + entry.samplesPerChunk > sampleSizes.length) throw new Error("stsc maps beyond stsz sample count.");
      let byteLength = 0;
      for (let j = 0; j < entry.samplesPerChunk; j += 1) byteLength += sampleSizes[sampleIndex + j];
      chunks.push({
        index: i,
        offset: offsets[i],
        firstSample: sampleIndex,
        sampleCount: entry.samplesPerChunk,
        byteLength,
      });
      sampleIndex += entry.samplesPerChunk;
    }
    if (sampleIndex !== sampleSizes.length) throw new Error("stsc/stco do not account for every sample in stsz.");
    return chunks;
  }

  function getSampleBytes(source, track, sampleIndex) {
    const chunk = findChunkForSample(track.chunks, sampleIndex);
    let offset = chunk.offset;
    for (let i = chunk.firstSample; i < sampleIndex; i += 1) offset += track.sampleSizes[i];
    return source.subarray(offset, offset + track.sampleSizes[sampleIndex]);
  }

  function findChunkForSample(chunks, sampleIndex) {
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const chunk = chunks[middle];
      if (sampleIndex < chunk.firstSample) high = middle - 1;
      else if (sampleIndex >= chunk.firstSample + chunk.sampleCount) low = middle + 1;
      else return chunk;
    }
    throw new Error(`Sample ${sampleIndex} has no chunk mapping.`);
  }

  function normalizeAudioTiming(source, moov, audioTrack) {
    const entries = readSttsEntries(source, audioTrack.stts);
    const mdhd = readMdhd(source, audioTrack.mdhd);
    const edit = audioTrack.edts ? readFirstElstEntry(source, audioTrack.edts) : null;
    if (!edit || edit.mediaTime < 0 || mdhd.timescale <= 0) return { entries, duration: mdhd.duration };
    const movieTimescale = readMovieTimescale(source, moov);
    const duration = edit.mediaTime + Math.round((edit.segmentDuration * mdhd.timescale) / movieTimescale);
    const currentDuration = entries.reduce((sum, entry) => sum + entry.sampleCount * entry.sampleDelta, 0);
    const adjustment = duration - currentDuration;
    if (!entries.length || entries[entries.length - 1].sampleDelta + adjustment <= 0) return { entries, duration: mdhd.duration };
    if (adjustment !== 0) {
      const last = entries.pop();
      if (last.sampleCount > 1) entries.push({ sampleCount: last.sampleCount - 1, sampleDelta: last.sampleDelta });
      entries.push({ sampleCount: 1, sampleDelta: last.sampleDelta + adjustment });
    }
    return { entries, duration };
  }

  function rebuildMoov(source, moov, tracks, audioTrack, tables, branding, audioTiming) {
    const replacements = new Map();
    for (const track of tracks) {
      const table = tables.get(track);
      replacements.set(track.stsz, makeStsz(source, track.stsz, table.sampleSizes));
      replacements.set(track.stsc, makeStsc(source, track.stsc, table.stscEntries));
      replacements.set(track.chunkOffsetsBox, makeChunkOffsets(table.chunkOffsets));
      if (track.sdtp) replacements.set(track.sdtp, new Uint8Array(0));
      if (track === audioTrack) {
        replacements.set(track.stts, makeStts(source, track.stts, audioTiming.entries));
        replacements.set(track.mdhd, patchMdhdDuration(source, track.mdhd, audioTiming.duration));
        if (track.edts) replacements.set(track.edts, new Uint8Array(0));
        if (track.udta) replacements.set(track.udta, new Uint8Array(0));
      }
    }

    const oldUdta = moov.children.find((box) => box.type === "udta");
    if (branding && oldUdta) replacements.set(oldUdta, makeBrandingUdta());
    const children = moov.children.map((child) => rebuildBox(source, child, replacements));
    if (branding && !oldUdta) children.push(makeBrandingUdta());
    return makeBox("moov", concat(children));
  }

  function makeBrandingUdta() {
    const copyright = String.fromCharCode(0xa9);
    const tags = [
      [`${copyright}ART`, "kryptonaep.it"],
      [`${copyright}wrt`, "kryptonaep.it"],
      [`${copyright}alb`, "kryptonaep Method"],
      [`${copyright}too`, "kryptonaep"],
      [`${copyright}cmt`, "Patched by method.kryptonaep.it"],
      ["cprt", "kryptonaep.it"],
      [`${copyright}grp`, "method.kryptonaep.it"],
    ];
    const hdlrPayload = new Uint8Array(25);
    writeType(hdlrPayload, 8, "mdir");
    const hdlr = makeBox("hdlr", hdlrPayload);
    const entries = tags.map(([type, value]) => {
      const text = utf8(value);
      const dataPayload = new Uint8Array(8 + text.byteLength);
      writeU32(dataPayload, 0, 1);
      dataPayload.set(text, 8);
      return makeBox(type, makeBox("data", dataPayload));
    });
    const meta = makeBox("meta", concat([new Uint8Array(4), hdlr, makeBox("ilst", concat(entries))]));
    return makeBox("udta", meta);
  }

  function makeStsz(source, oldBox, sizes) {
    const payload = new Uint8Array(12 + sizes.length * 4);
    payload.set(source.subarray(oldBox.start + 8, oldBox.start + 12), 0);
    writeU32(payload, 8, sizes.length);
    for (let i = 0, cursor = 12; i < sizes.length; i += 1, cursor += 4) writeU32(payload, cursor, sizes[i]);
    return makeBox("stsz", payload);
  }

  function makeStts(source, oldBox, entries) {
    const payload = new Uint8Array(8 + entries.length * 8);
    payload.set(source.subarray(oldBox.start + 8, oldBox.start + 12), 0);
    writeU32(payload, 4, entries.length);
    for (let i = 0, cursor = 8; i < entries.length; i += 1, cursor += 8) {
      writeU32(payload, cursor, entries[i].sampleCount);
      writeU32(payload, cursor + 4, entries[i].sampleDelta);
    }
    return makeBox("stts", payload);
  }

  function patchMdhdDuration(source, box, duration) {
    const out = source.slice(box.start, box.end);
    if (out[8] === 1) writeU64(out, 32, BigInt(duration));
    else writeU32(out, 24, duration);
    return out;
  }

  function makeStsc(source, oldBox, entries) {
    const payload = new Uint8Array(8 + entries.length * 12);
    payload.set(source.subarray(oldBox.start + 8, oldBox.start + 12), 0);
    writeU32(payload, 4, entries.length);
    for (let i = 0, cursor = 8; i < entries.length; i += 1, cursor += 12) {
      writeU32(payload, cursor, entries[i].firstChunk);
      writeU32(payload, cursor + 4, entries[i].samplesPerChunk);
      writeU32(payload, cursor + 8, entries[i].sampleDescriptionIndex);
    }
    return makeBox("stsc", payload);
  }

  function makeChunkOffsets(offsets) {
    const use64 = offsets.some((offset) => offset > 0xffffffff);
    const payload = new Uint8Array(8 + offsets.length * (use64 ? 8 : 4));
    writeU32(payload, 4, offsets.length);
    let cursor = 8;
    for (const offset of offsets) {
      if (use64) { writeU64(payload, cursor, BigInt(offset)); cursor += 8; }
      else { writeU32(payload, cursor, offset); cursor += 4; }
    }
    return makeBox(use64 ? "co64" : "stco", payload);
  }

  function validateChunkRanges(source, rootBoxes, records) {
    const ranges = rootBoxes.filter((box) => box.type === "mdat").map((box) => [box.start + box.header, box.end]);
    let previousEnd = -1;
    for (const { chunk } of records) {
      const end = chunk.offset + chunk.byteLength;
      if (!ranges.some(([start, rangeEnd]) => chunk.offset >= start && end <= rangeEnd)) {
        throw new Error("A chunk offset points outside mdat.");
      }
      if (chunk.offset < previousEnd) throw new Error("Overlapping media chunks are not supported.");
      previousEnd = end;
    }
  }

  function readSampleEntryType(source, stbl) {
    const stsd = findBox(stbl, ["stsd"]);
    return stsd && readU32(source, stsd.start + 12) > 0 ? readType(source, stsd.start + 20) : null;
  }

  function parseChildren(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = readU32(bytes, offset);
      const type = readType(bytes, offset + 4);
      let header = 8;
      let size = size32;
      if (size32 === 1) { size = Number(readU64(bytes, offset + 8)); header = 16; }
      else if (size32 === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
      const box = { type, start: offset, end: offset + size, size, header, children: [] };
      const childStart = offset + header + (type === "meta" ? 4 : 0);
      if (CONTAINER_TYPES.has(type) && childStart < box.end) box.children = parseChildren(bytes, childStart, box.end);
      boxes.push(box);
      offset += size;
    }
    return boxes;
  }

  function rebuildBox(source, box, replacements) {
    if (replacements.has(box)) return replacements.get(box);
    const childrenStart = box.start + box.header + (box.type === "meta" ? 4 : 0);
    const payload = box.children.length
      ? concat([
        source.subarray(box.start + box.header, childrenStart),
        ...box.children.map((child) => rebuildBox(source, child, replacements)),
      ])
      : source.subarray(box.start + box.header, box.end);
    return makeBox(box.type, payload);
  }

  function readStsz(bytes, box) {
    const sampleSize = readU32(bytes, box.start + 12);
    const count = readU32(bytes, box.start + 16);
    if (sampleSize !== 0) return new Array(count).fill(sampleSize);
    const sizes = new Array(count);
    for (let i = 0, cursor = box.start + 20; i < count; i += 1, cursor += 4) sizes[i] = readU32(bytes, cursor);
    return sizes;
  }

  function readStscEntries(bytes, box) {
    const count = readU32(bytes, box.start + 12);
    const entries = [];
    for (let i = 0, cursor = box.start + 16; i < count; i += 1, cursor += 12) {
      entries.push({
        firstChunk: readU32(bytes, cursor),
        samplesPerChunk: readU32(bytes, cursor + 4),
        sampleDescriptionIndex: readU32(bytes, cursor + 8),
      });
    }
    return entries;
  }

  function readChunkOffsets(bytes, box) {
    const count = readU32(bytes, box.start + 12);
    const offsets = new Array(count);
    const width = box.type === "co64" ? 8 : 4;
    for (let i = 0, cursor = box.start + 16; i < count; i += 1, cursor += width) {
      offsets[i] = box.type === "co64" ? Number(readU64(bytes, cursor)) : readU32(bytes, cursor);
    }
    return offsets;
  }

  function readSttsEntries(bytes, box) {
    const count = readU32(bytes, box.start + 12);
    const entries = [];
    for (let i = 0, cursor = box.start + 16; i < count; i += 1, cursor += 8) {
      entries.push({ sampleCount: readU32(bytes, cursor), sampleDelta: readU32(bytes, cursor + 4) });
    }
    return entries;
  }

  function readMdhd(source, box) {
    return source[box.start + 8] === 1
      ? { timescale: readU32(source, box.start + 28), duration: Number(readU64(source, box.start + 32)) }
      : { timescale: readU32(source, box.start + 20), duration: readU32(source, box.start + 24) };
  }

  function readMovieTimescale(source, moov) {
    const mvhd = findBox(moov, ["mvhd"]);
    if (!mvhd) throw new Error("MP4 mvhd atom not found.");
    return source[mvhd.start + 8] === 1 ? readU32(source, mvhd.start + 28) : readU32(source, mvhd.start + 20);
  }

  function readFirstElstEntry(source, edts) {
    const elst = findBox(edts, ["elst"]);
    if (!elst || readU32(source, elst.start + 12) < 1) return null;
    const version = source[elst.start + 8];
    return version === 1
      ? { segmentDuration: Number(readU64(source, elst.start + 16)), mediaTime: Number(readI64(source, elst.start + 24)) }
      : { segmentDuration: readU32(source, elst.start + 16), mediaTime: readI32(source, elst.start + 20) };
  }

  function getTrackKind(trak, source) {
    const hdlr = findBox(trak, ["mdia", "hdlr"]);
    return hdlr ? readType(source, hdlr.start + hdlr.header + 8) : null;
  }

  function findBox(parent, path) {
    let current = parent;
    for (const type of path) {
      current = current?.children?.find((box) => box.type === type);
      if (!current) return null;
    }
    return current;
  }

  function makeFtyp() {
    const payload = new Uint8Array(24);
    writeType(payload, 0, "isom");
    writeU32(payload, 4, 512);
    writeType(payload, 8, "isom");
    writeType(payload, 12, "iso2");
    writeType(payload, 16, "avc1");
    writeType(payload, 20, "mp41");
    return makeBox("ftyp", payload);
  }

  function makeMdatHeader(mediaBytes, headerSize) {
    const out = new Uint8Array(headerSize);
    const totalSize = mediaBytes + headerSize;
    if (headerSize === 16) {
      writeU32(out, 0, 1);
      writeType(out, 4, "mdat");
      writeU64(out, 8, BigInt(totalSize));
    } else {
      writeU32(out, 0, totalSize);
      writeType(out, 4, "mdat");
    }
    return out;
  }

  function makeBox(type, payload) {
    const size = payload.byteLength + 8;
    if (size > 0xffffffff) throw new Error(`Box ${type} exceeds 32-bit size.`);
    const out = new Uint8Array(size);
    writeU32(out, 0, size);
    writeType(out, 4, type);
    out.set(payload, 8);
    return out;
  }

  function repeatBytes(pattern, count) {
    const out = new Uint8Array(pattern.byteLength * count);
    for (let cursor = 0; cursor < out.byteLength; cursor += pattern.byteLength) out.set(pattern, cursor);
    return out;
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) { out.set(part, cursor); cursor += part.byteLength; }
    return out;
  }

  function utf8(value) { return new TextEncoder().encode(value); }
  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return value.constructor === Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(value);
  }
  function readType(bytes, offset) { return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]); }
  function writeType(bytes, offset, value) { for (let i = 0; i < 4; i += 1) bytes[offset + i] = value.charCodeAt(i); }
  function readU32(bytes, offset) { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }
  function readI32(bytes, offset) { return readU32(bytes, offset) | 0; }
  function writeU32(bytes, offset, value) { bytes[offset] = (value >>> 24) & 0xff; bytes[offset + 1] = (value >>> 16) & 0xff; bytes[offset + 2] = (value >>> 8) & 0xff; bytes[offset + 3] = value & 0xff; }
  function readU64(bytes, offset) { return (BigInt(readU32(bytes, offset)) << 32n) | BigInt(readU32(bytes, offset + 4)); }
  function readI64(bytes, offset) { const value = readU64(bytes, offset); return value & (1n << 63n) ? value - (1n << 64n) : value; }
  function writeU64(bytes, offset, value) { writeU32(bytes, offset, Number((value >> 32n) & 0xffffffffn)); writeU32(bytes, offset + 4, Number(value & 0xffffffffn)); }

  return { patchAibantoContainer, patchWithReport };
});