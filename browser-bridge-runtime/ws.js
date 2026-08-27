// Derived from dsh-browser-bridge (MIT). See THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export class WebSocketConnection {
  constructor(socket, options = {}) {
    this.socket = socket
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024
    this.messageListener = null
    this.closeListener = null
    this.errorListener = null
    this.buffer = Buffer.alloc(0)
    this.fragmentOpcode = 0
    this.fragments = []
    this.fragmentBytes = 0
    this.closing = false
    this.closed = false

    socket.on('data', chunk => this.onData(chunk))
    socket.on('error', error => {
      this.errorListener?.(error)
      this.teardown()
    })
    socket.on('close', () => this.teardown())
  }

  onMessage(listener) { this.messageListener = listener }
  onClose(listener) { this.closeListener = listener }
  onError(listener) { this.errorListener = listener }

  send(text) {
    if (this.closing || this.closed) return false
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8')))
    return true
  }

  close(code = 1000, reason = '') {
    if (this.closing || this.closed) return
    this.closing = true
    try {
      const reasonBytes = Buffer.from(String(reason), 'utf8')
      const payload = Buffer.alloc(2 + reasonBytes.length)
      payload.writeUInt16BE(code, 0)
      reasonBytes.copy(payload, 2)
      this.socket.write(encodeFrame(OP_CLOSE, payload))
      this.socket.end()
    } catch {
      this.socket.destroy()
    }
  }

  onData(chunk) {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    try {
      this.consume()
    } catch (error) {
      this.close(1002, 'protocol error')
      this.errorListener?.(error)
    }
  }

  consume() {
    for (;;) {
      const buf = this.buffer
      if (buf.length < 2) return
      const first = buf[0]
      const second = buf[1]
      if (first === undefined || second === undefined) return
      const fin = (first & 0x80) !== 0
      if ((first & 0x70) !== 0) throw new Error('RSV bits are unsupported')
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let len = second & 0x7f
      let offset = 2

      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(this.maxMessageBytes)) throw new Error('frame too large')
        len = Number(big)
        offset = 10
      }

      if (opcode >= 0x8 && (!fin || len > 125)) throw new Error('invalid websocket control frame')
      if (!masked) throw new Error('client websocket frames must be masked')
      if (buf.length < offset + 4) return
      const maskKey = buf.subarray(offset, offset + 4)
      offset += 4
      if (len > this.maxMessageBytes) throw new Error('frame too large')
      if (buf.length < offset + len) return

      const payload = Buffer.from(buf.subarray(offset, offset + len))
      for (let index = 0; index < payload.length; index += 1) {
        const maskByte = maskKey[index & 3]
        if (maskByte !== undefined) payload[index] ^= maskByte
      }
      this.buffer = buf.subarray(offset + len)

      if (opcode === OP_CLOSE) {
        if (payload.length === 1) throw new Error('invalid close payload')
        let code = 1000
        if (payload.length >= 2) code = payload.readUInt16BE(0)
        this.close(code === 1005 ? 1000 : code)
        return
      }
      if (opcode === OP_PING) {
        this.socket.write(encodeFrame(OP_PONG, payload))
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_BINARY) throw new Error('binary frames unsupported')

      if (opcode === OP_TEXT) {
        if (this.fragmentOpcode !== 0) throw new Error('new data frame during fragmentation')
        if (fin) this.deliver(payload)
        else {
          this.fragmentOpcode = OP_TEXT
          this.fragments = [payload]
          this.fragmentBytes = payload.length
        }
        continue
      }

      if (opcode === 0x0) {
        if (this.fragmentOpcode === 0) throw new Error('unexpected continuation frame')
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > this.maxMessageBytes) throw new Error('message too large')
        if (fin) {
          const message = Buffer.concat(this.fragments, this.fragmentBytes)
          this.fragmentOpcode = 0
          this.fragments = []
          this.fragmentBytes = 0
          this.deliver(message)
        }
        continue
      }

      throw new Error(`unsupported opcode ${opcode}`)
    }
  }

  deliver(payload) {
    const text = payload.toString('utf8')
    try { this.messageListener?.(text) } catch (error) { this.errorListener?.(error) }
  }

  teardown() {
    if (this.closed) return
    this.closed = true
    this.closeListener?.()
  }
}

export function handleUpgrade(req, socket, head, options = {}) {
  const headers = req.headers
  const upgrade = String(headers.upgrade ?? '').toLowerCase()
  const connection = String(headers.connection ?? '').toLowerCase()
  if (upgrade !== 'websocket' || !connection.includes('upgrade')) throw new Error('not a websocket upgrade')
  const key = headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) throw new Error('missing sec-websocket-key')
  const version = String(headers['sec-websocket-version'] ?? '')
  if (version !== '13') throw new Error('unsupported websocket version')
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n',
  )
  const connectionObject = new WebSocketConnection(socket, options)
  if (head && head.length > 0) connectionObject.onData(head)
  return connectionObject
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}
