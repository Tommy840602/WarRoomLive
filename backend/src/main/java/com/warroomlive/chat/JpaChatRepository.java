package com.warroomlive.chat;

import com.warroomlive.events.OutboxRecorder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Durable chat store backed by PostgreSQL; active under the {@code postgres} profile. */
@Repository
@Profile("postgres")
public class JpaChatRepository implements ChatRepository {

    private final ChatMessageJpaRepository jpa;
    private final ObjectProvider<OutboxRecorder> outbox;

    public JpaChatRepository(ChatMessageJpaRepository jpa, ObjectProvider<OutboxRecorder> outbox) {
        this.jpa = jpa;
        this.outbox = outbox;
    }

    /**
     * Message row and its {@code chat.message.created} outbox event commit in one
     * transaction (the outbox recorder only exists under the {@code kafka} profile).
     */
    @Override
    @Transactional
    public void append(String room, StoredMessage message) {
        jpa.save(new ChatMessageEntity(room, message));
        outbox.ifAvailable(recorder -> recorder.record(
                "chat.message.created", "room", room,
                Map.of("fromId", message.fromId(), "name", message.name(),
                        "text", message.text(), "ts", message.ts())));
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
