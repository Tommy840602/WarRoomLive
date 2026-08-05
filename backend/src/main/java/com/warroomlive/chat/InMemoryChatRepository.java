package com.warroomlive.chat;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Repository;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Default chat store: a bounded per-room ring buffer in process memory.
 *
 * <p>History survives page refreshes and new joins while the server is up, but is lost
 * on restart. Switch to the {@code postgres} profile for durability. Active whenever the
 * {@code postgres} profile is not.
 */
@Repository
@Profile("!postgres")
public class InMemoryChatRepository implements ChatRepository {

    private final int capacity;
    private final Map<String, Deque<StoredMessage>> byRoom = new ConcurrentHashMap<>();

    public InMemoryChatRepository(@Value("${warroomlive.chat.history-limit:100}") int capacity) {
        this.capacity = capacity;
    }

    @Override
    public void append(String room, StoredMessage message) {
        Deque<StoredMessage> history = byRoom.computeIfAbsent(room, r -> new ArrayDeque<>());
        synchronized (history) {
            history.addLast(message);
            while (history.size() > capacity) {
                history.removeFirst();
            }
        }
    }

    @Override
    public List<StoredMessage> recent(String room, int limit) {
        Deque<StoredMessage> history = byRoom.get(room);
        if (history == null) {
            return List.of();
        }
        synchronized (history) {
            List<StoredMessage> all = new ArrayList<>(history);
            int from = Math.max(0, all.size() - limit);
            return List.copyOf(all.subList(from, all.size()));
        }
    }
}
