// data should be the same type of format returned by parseMidi
// Returns a Uint8Array of the encoded MIDI bytes. Previously this returned
// `Array<number>`; Uint8Array is broadly interchangeable (Buffer.from(...),
// parseMidi(...), fs.writeFileSync(..., buf), etc. all accept it) and avoids
// a final O(n) type conversion. If an Array is required, spread via
// `[...writeMidi(data)]`.

// opts:
// - running              reuse previous eventTypeByte when possible, to compress file
// - useByte9ForNoteOff   use 0x09 for noteOff when velocity is zero

function writeMidi(data, opts) {
  if (typeof data !== 'object')
    throw 'Invalid MIDI data'

  opts = opts || {}

  var header = data.header || {}
  var tracks = data.tracks || []
  var i, len = tracks.length

  var w = new Writer()
  writeHeader(w, header, len)

  for (i=0; i < len; i++) {
    writeTrack(w, tracks[i], opts)
  }

  // slice() returns a detached Uint8Array sized exactly to the used bytes, so
  // callers hold a self-contained buffer not a view into Writer's growth arena.
  return w.buffer.slice(0, w.pos)
}

function writeHeader(w, header, numTracks) {
  var format = header.format == null ? 1 : header.format

  var timeDivision = 128
  if (header.timeDivision) {
    timeDivision = header.timeDivision
  } else if (header.ticksPerFrame && header.framesPerSecond) {
    timeDivision = (-(header.framesPerSecond & 0xFF) << 8) | (header.ticksPerFrame & 0xFF)
  } else if (header.ticksPerBeat) {
    timeDivision = header.ticksPerBeat & 0x7FFF
  }

  var h = new Writer()
  h.writeUInt16(format)
  h.writeUInt16(numTracks)
  h.writeUInt16(timeDivision)

  w.writeChunk('MThd', h.used())
}

function writeTrack(w, track, opts) {
  var t = new Writer()
  var i, len = track.length
  var eventTypeByte = null
  for (i=0; i < len; i++) {
    // Reuse last eventTypeByte when opts.running is set, or event.running is explicitly set on it.
    // parseMidi will set event.running for each event, so that we can get an exact copy by default.
    // Explicitly set opts.running to false, to override event.running and never reuse last eventTypeByte.
    if (opts.running === false || !opts.running && !track[i].running) eventTypeByte = null

    eventTypeByte = writeEvent(t, track[i], eventTypeByte, opts.useByte9ForNoteOff)
  }
  w.writeChunk('MTrk', t.used())
}

function writeEvent(w, event, lastEventTypeByte, useByte9ForNoteOff) {
  var type = event.type
  var deltaTime = event.deltaTime
  var text = event.text || ''
  var data = event.data || []
  var eventTypeByte = null
  w.writeVarInt(deltaTime)

  switch (type) {
    // meta events
    case 'sequenceNumber':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x00)
      w.writeVarInt(2)
      w.writeUInt16(event.number)
      break;

    case 'text':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x01)
      w.writeStringWithLength(text)
      break;

    case 'copyrightNotice':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x02)
      w.writeStringWithLength(text)
      break;

    case 'trackName':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x03)
      w.writeStringWithLength(text)
      break;

    case 'instrumentName':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x04)
      w.writeStringWithLength(text)
      break;

    case 'lyrics':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x05)
      w.writeStringWithLength(text)
      break;

    case 'marker':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x06)
      w.writeStringWithLength(text)
      break;

    case 'cuePoint':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x07)
      w.writeStringWithLength(text)
      break;

    case 'channelPrefix':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x20)
      w.writeVarInt(1)
      w.writeUInt8(event.channel)
      break;

    case 'portPrefix':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x21)
      w.writeVarInt(1)
      w.writeUInt8(event.port)
      break;

    case 'endOfTrack':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x2F)
      w.writeVarInt(0)
      break;

    case 'setTempo':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x51)
      w.writeVarInt(3)
      w.writeUInt24(event.microsecondsPerBeat)
      break;

    case 'smpteOffset':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x54)
      w.writeVarInt(5)
      var FRAME_RATES = { 24: 0x00, 25: 0x20, 29: 0x40, 30: 0x60 }
      var hourByte = (event.hour & 0x1F) | FRAME_RATES[event.frameRate]
      w.writeUInt8(hourByte)
      w.writeUInt8(event.min)
      w.writeUInt8(event.sec)
      w.writeUInt8(event.frame)
      w.writeUInt8(event.subFrame)
      break;

    case 'timeSignature':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x58)
      w.writeVarInt(4)
      w.writeUInt8(event.numerator)
      var denominator = Math.floor((Math.log(event.denominator) / Math.LN2)) & 0xFF
      w.writeUInt8(denominator)
      w.writeUInt8(event.metronome)
      w.writeUInt8(event.thirtyseconds || 8)
      break;

    case 'keySignature':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x59)
      w.writeVarInt(2)
      w.writeInt8(event.key)
      w.writeUInt8(event.scale)
      break;

    case 'sequencerSpecific':
      w.writeUInt8(0xFF)
      w.writeUInt8(0x7F)
      w.writeVarInt(data.length)
      w.writeBytes(data)
      break;

    case 'unknownMeta':
      if (event.metatypeByte != null) {
        w.writeUInt8(0xFF)
        w.writeUInt8(event.metatypeByte)
        w.writeVarInt(data.length)
        w.writeBytes(data)
      }
      break;

    // system-exclusive
    case 'sysEx':
      w.writeUInt8(0xF0)
      w.writeVarInt(data.length)
      w.writeBytes(data)
      break;

    case 'endSysEx':
      w.writeUInt8(0xF7)
      w.writeVarInt(data.length)
      w.writeBytes(data)
      break;

    // channel events
    case 'noteOff':
      // Use 0x90 when opts.useByte9ForNoteOff is set and velocity is zero, or when event.byte9 is explicitly set on it.
      // parseMidi will set event.byte9 for each event, so that we can get an exact copy by default.
      // Explicitly set opts.useByte9ForNoteOff to false, to override event.byte9 and always use 0x80 for noteOff events.
      var noteByte = ((useByte9ForNoteOff !== false && event.byte9) || (useByte9ForNoteOff && event.velocity == 0)) ? 0x90 : 0x80

      eventTypeByte = noteByte | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.noteNumber)
      w.writeUInt8(event.velocity)
      break;

    case 'noteOn':
      eventTypeByte = 0x90 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.noteNumber)
      w.writeUInt8(event.velocity)
      break;

    case 'noteAftertouch':
      eventTypeByte = 0xA0 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.noteNumber)
      w.writeUInt8(event.amount)
      break;

    case 'controller':
      eventTypeByte = 0xB0 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.controllerType)
      w.writeUInt8(event.value)
      break;

    case 'programChange':
      eventTypeByte = 0xC0 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.programNumber)
      break;

    case 'channelAftertouch':
      eventTypeByte = 0xD0 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      w.writeUInt8(event.amount)
      break;

    case 'pitchBend':
      eventTypeByte = 0xE0 | event.channel
      if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte)
      var value14 = 0x2000 + event.value
      var lsb14 = (value14 & 0x7F)
      var msb14 = (value14 >> 7) & 0x7F
      w.writeUInt8(lsb14)
      w.writeUInt8(msb14)
    break;

    default:
      throw 'Unrecognized event type: ' + type
  }
  return eventTypeByte
}


// Growable Uint8Array + cursor. Previously the writer pushed into an
// Array<number>, which meant every byte was a boxed JS number (~8× the
// memory of a raw byte) and every push ran through V8's Array growth path.
// A typed buffer lets writeBytes(Uint8Array) fall through to a single
// TypedArray.set() call and keeps hot writes as raw byte stores, not boxed
// numbers — which both cuts GC pressure and lets the inlined writeVarInt
// write directly to the buffer instead of through any temp.
function Writer() {
  this.buffer = new Uint8Array(1024)
  this.pos = 0
}

Writer.prototype._ensure = function(n) {
  var need = this.pos + n
  var cap = this.buffer.length
  if (need <= cap) return
  while (cap < need) cap *= 2
  var bigger = new Uint8Array(cap)
  bigger.set(this.buffer.subarray(0, this.pos))
  this.buffer = bigger
}

// Returns a view over the bytes written so far. Used by writeChunk to emit
// nested sub-writers; callers outside this module should prefer the public
// writeMidi return value (a detached Uint8Array).
Writer.prototype.used = function() {
  return this.buffer.subarray(0, this.pos)
}

Writer.prototype.writeUInt8 = function(v) {
  if (this.pos >= this.buffer.length) this._ensure(1)
  this.buffer[this.pos++] = v & 0xFF
}
Writer.prototype.writeInt8 = Writer.prototype.writeUInt8

Writer.prototype.writeUInt16 = function(v) {
  this._ensure(2)
  var buf = this.buffer
  buf[this.pos++] = (v >> 8) & 0xFF
  buf[this.pos++] = v & 0xFF
}
Writer.prototype.writeInt16 = Writer.prototype.writeUInt16

Writer.prototype.writeUInt24 = function(v) {
  this._ensure(3)
  var buf = this.buffer
  buf[this.pos++] = (v >> 16) & 0xFF
  buf[this.pos++] = (v >> 8) & 0xFF
  buf[this.pos++] = v & 0xFF
}
Writer.prototype.writeInt24 = Writer.prototype.writeUInt24

Writer.prototype.writeUInt32 = function(v) {
  this._ensure(4)
  var buf = this.buffer
  buf[this.pos++] = (v >> 24) & 0xFF
  buf[this.pos++] = (v >> 16) & 0xFF
  buf[this.pos++] = (v >> 8) & 0xFF
  buf[this.pos++] = v & 0xFF
}
Writer.prototype.writeInt32 = Writer.prototype.writeUInt32


// writeBytes accepts Uint8Array / Buffer / plain Array of byte values.
// Typed arrays fall through to a single .set() (memcpy-ish); plain arrays
// use a per-element copy.
Writer.prototype.writeBytes = function(arr) {
  var len = arr.length
  this._ensure(len)
  var buf = this.buffer
  if (arr.buffer !== undefined) {
    // Typed array / Buffer — bulk copy via .set().
    buf.set(arr, this.pos)
    this.pos += len
  } else {
    for (var i = 0; i < len; i++) buf[this.pos++] = arr[i] & 0xFF
  }
}

// UTF-8 encode the string and write the bytes. Previously
// `str.codePointAt(i)` produced one number per UTF-16 code unit, which (a)
// wrote the wrong bytes for non-ASCII characters in the high-byte plane and
// (b) was inconsistent with the byte-count used for meta-event length
// prefixes. TextEncoder is a pure-JS call available in Node and browsers.
var sharedUtf8Encoder = new TextEncoder()
Writer.prototype.writeString = function(str) {
  var bytes = sharedUtf8Encoder.encode(str)
  this._ensure(bytes.length)
  this.buffer.set(bytes, this.pos)
  this.pos += bytes.length
}

// Write a text meta-event payload: the variable-length byte-count followed
// by the UTF-8 encoded bytes. This replaces the previous pattern
// `writeVarInt(text.length); writeString(text)` which was incorrect for
// multi-byte characters — `text.length` is UTF-16 code units, not bytes, so
// the length prefix could undercount and corrupt downstream events.
Writer.prototype.writeStringWithLength = function(str) {
  var bytes = sharedUtf8Encoder.encode(str)
  this.writeVarInt(bytes.length)
  this._ensure(bytes.length)
  this.buffer.set(bytes, this.pos)
  this.pos += bytes.length
}

// Inline varint encoding — writes the 1–4 byte tail directly into the
// buffer instead of going through a reversed temp array.
Writer.prototype.writeVarInt = function(v) {
  if (v < 0) throw "Cannot write negative variable-length integer"

  if (v <= 0x7F) {
    this._ensure(1)
    this.buffer[this.pos++] = v
  } else if (v <= 0x3FFF) {
    this._ensure(2)
    var buf = this.buffer
    buf[this.pos++] = ((v >> 7) & 0x7F) | 0x80
    buf[this.pos++] = v & 0x7F
  } else if (v <= 0x1FFFFF) {
    this._ensure(3)
    var buf2 = this.buffer
    buf2[this.pos++] = ((v >> 14) & 0x7F) | 0x80
    buf2[this.pos++] = ((v >> 7) & 0x7F) | 0x80
    buf2[this.pos++] = v & 0x7F
  } else if (v <= 0xFFFFFFF) {
    this._ensure(4)
    var buf3 = this.buffer
    buf3[this.pos++] = ((v >> 21) & 0x7F) | 0x80
    buf3[this.pos++] = ((v >> 14) & 0x7F) | 0x80
    buf3[this.pos++] = ((v >> 7) & 0x7F) | 0x80
    buf3[this.pos++] = v & 0x7F
  } else {
    // Fallback for >28-bit values (rare in MIDI files; delta-times and
    // chunk lengths are bounded well below this).
    var i = v
    var bytes = []
    bytes.push(i & 0x7F)
    i = Math.floor(i / 128)
    while (i) {
      bytes.push((i & 0x7F) | 0x80)
      i = Math.floor(i / 128)
    }
    this._ensure(bytes.length)
    var buf4 = this.buffer
    for (var j = bytes.length - 1; j >= 0; j--) buf4[this.pos++] = bytes[j]
  }
}

Writer.prototype.writeChunk = function(id, data) {
  this.writeString(id)
  this.writeUInt32(data.length)
  this.writeBytes(data)
}

module.exports = writeMidi
