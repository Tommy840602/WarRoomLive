package com.warroomlive.chat;

/**
 * A persisted chat message, independent of the storage backend.
 *
 * @param fromId  peer id of the sender at the time it was sent
 * @param name    sender's display name at the time it was sent
 * @param text    message body
 * @param ts      epoch milliseconds when the server received it
 */
public record StoredMessage(String fromId, String name, String text, long ts) {
}
