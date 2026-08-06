package com.warroomlive.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Records a business event into the outbox. Callers invoke this inside their own
 * transaction, so the event row commits (or rolls back) atomically with the
 * aggregate write — the heart of the transactional-outbox pattern.
 *
 * <p>Only present under the {@code kafka} profile (which requires {@code postgres});
 * without it callers simply skip recording and no backlog accumulates.
 */
@Component
@Profile("kafka")
public class OutboxRecorder {

    private final OutboxJpaRepository outbox;
    private final ObjectMapper mapper;

    public OutboxRecorder(OutboxJpaRepository outbox, ObjectMapper mapper) {
        this.outbox = outbox;
        this.mapper = mapper;
    }

    public void record(String eventType, String aggregateType, String aggregateId, Map<String, Object> payload) {
        try {
            outbox.save(new OutboxEventEntity(
                    eventType, aggregateType, aggregateId, mapper.writeValueAsString(payload)));
        } catch (Exception e) {
            throw new IllegalStateException("failed to record outbox event " + eventType, e);
        }
    }
}
