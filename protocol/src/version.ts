/**
 * Wire protocol version. Bumped on any breaking change to frames, commands, or events.
 * A client and hub with different versions refuse the connection in `hello` rather than
 * misreading each other (ADR-0008).
 */
export const PROTOCOL_VERSION = 1;
