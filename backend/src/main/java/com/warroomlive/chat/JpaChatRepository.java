package com.warroomlive.chat;

import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.List;

/** Durable chat store backed by PostgreSQL; active under the {@code postgres} profile. */
@Repository
@Profile("postgres")
public class JpaChatRepository implements ChatRepository {

    private final ChatMessageJpaRepository jpa;

    public JpaChatRepository(ChatMessageJpaRepository jpa) {
        this.jpa = jpa;
    }

    @Override
    public void append(String room, StoredMessage message) {
        jpa.save(new ChatMessageEntity(room, message));
    }

    @Override
    public List<StoredMessage> recent(String room, int limit) {
        List<ChatMessageEntity> newestFirst = jpa.findByRoomOrderByIdDesc(room, Limit.of(limit));
        List<StoredMessage> chronological = new ArrayList<>(newestFirst.size());
        for (int i = newestFirst.size() - 1; i >= 0; i--) {
            chronological.add(newestFirst.get(i).toStored());
        }
        return chronological;
    }
}
