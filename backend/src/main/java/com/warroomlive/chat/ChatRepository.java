package com.warroomlive.chat;

import java.util.List;

/**
 * Storage for room chat history. Two implementations exist, selected by Spring profile:
 * {@link InMemoryChatRepository} (default, bounded, non-durable) and
 * {@link JpaChatRepository} (profile {@code postgres}, durable).
 */
public interface ChatRepository {

    /** Appends a message to a room's history. */
    void append(String room, StoredMessage message);

    /** Returns up to {@code limit} of the most recent messages, oldest first. */
    List<StoredMessage> recent(String room, int limit);
}
