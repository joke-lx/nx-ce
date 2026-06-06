/**
 * 协议 — 长度前缀的 JSON 消息通信
 *
 * 线缆格式（与 native_host/internal/protocol/protocol.go 一致）：
 *   [4 字节 LE uint32 = 载荷长度][UTF-8 JSON 载荷]
 *
 * 这是 nx-ce 与原生主机之间的唯一通信契约。
 */

import { Buffer } from 'node:buffer';

/** 单条消息最大字节数（10 MB，与 Go 端对齐） */
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

/**
 * 从可读流中精确读取 n 个字节。
 *
 * @param {import('stream').Readable} stream - 可读流
 * @param {number} n - 需要读取的字节数
 * @returns {Promise<Buffer|null>} 成功返回 Buffer，正常 EOF 返回 null，出错则 reject
 */
function readExactly(stream, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let remaining = n;

    /** 尝试从流中同步读取数据 */
    function tryRead() {
      while (remaining > 0) {
        const chunk = stream.read(remaining);
        if (chunk === null) {
          // 暂无数据 — 等待 readable 或 end 事件
          waitForData();
          return;
        }
        chunks.push(chunk);
        remaining -= chunk.length;
      }
      // 已读取全部所需字节
      cleanup();
      resolve(Buffer.concat(chunks));
    }

    /** 注册异步等待回调 */
    function waitForData() {
      // 流已结束 → 信号 EOF
      if (stream.readableEnded || stream.destroyed) {
        cleanup();
        resolve(null);
        return;
      }
      stream.once('readable', tryRead);
      stream.once('end', onEnd);
      stream.once('error', onError);
    }

    function onEnd() {
      cleanup();
      resolve(null);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    /** 清理注册的事件监听器 */
    function cleanup() {
      stream.removeListener('readable', tryRead);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    }

    tryRead();
  });
}

/**
 * 从可读流中读取一条消息。
 *
 * @param {import('stream').Readable} stream - 可读流
 * @returns {Promise<object|null>} 解析后的 JSON 对象，正常 EOF 返回 null
 */
export async function readMessage(stream) {
  const headerBuf = await readExactly(stream, 4);
  if (headerBuf === null) return null; // 正常 EOF

  const length = headerBuf.readUInt32LE(0); // 小端序解析载荷长度

  if (length > MAX_MESSAGE_SIZE) {
    throw new Error(`message too large: ${length}`);
  }

  const payloadBuf = await readExactly(stream, length);
  if (payloadBuf === null) {
    throw new Error('unexpected EOF during message payload');
  }

  return JSON.parse(payloadBuf.toString('utf8'));
}

/**
 * 向可写流中写入一条消息。
 *
 * @param {import('stream').Writable} stream - 可写流
 * @param {object} data - 要发送的数据对象（会被 JSON 序列化）
 */
export function writeMessage(stream, data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0); // 小端序写入载荷长度

  stream.write(header);
  stream.write(payload);
}
