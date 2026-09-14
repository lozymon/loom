import type { Socket } from "node:net";
import { Duplex } from "node:stream";

/**
 * A Duplex over `socket` that first yields `prefix`: bytes already read from the socket (a ClientHello,
 * a request head). Node's TLS server reads a real socket's native handle directly and would miss bytes
 * given back with `unshift`; over a plain Duplex it reads through JavaScript and sees them.
 */
export function withPrefix(socket: Socket, prefix: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(err, callback) {
      socket.destroy(err ?? undefined);
      callback(err);
    },
  });
  if (prefix.length) stream.push(prefix);
  socket.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("close", () => stream.destroy());
  socket.on("error", (err) => stream.destroy(err));
  return stream;
}
