package com.warroomlive.recordings;

import com.warroomlive.events.OutboxRecorder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Records finished recordings and answers the list query.
 *
 * <p>Present only under the {@code postgres} profile — like the meeting tracker,
 * because the default profile excludes the JPA auto-configuration entirely so
 * the app can run with no database at all.
 *
 * <p>The row and the {@code meeting.recording.completed} event commit together,
 * so a consumer of the backbone and the in-app list can never disagree about
 * which recordings exist. Egress can redeliver a webhook, so writing is
 * idempotent on the egress id.
 */
@Component
@Profile("postgres")
public class RecordingStore {

    private static final Logger log = LoggerFactory.getLogger(RecordingStore.class);

    private final RecordingJpaRepository repository;
    private final ObjectProvider<OutboxRecorder> outbox;

    public RecordingStore(RecordingJpaRepository repository, ObjectProvider<OutboxRecorder> outbox) {
        this.repository = repository;
        this.outbox = outbox;
    }

    @Transactional
    public void completed(String room, String egressId, String objectKey,
            long sizeBytes, long durationMs, Instant startedAt, Instant endedAt) {
        if (repository.findByEgressId(egressId).isPresent()) {
            log.debug("Ignoring redelivered recording webhook for egress {}", egressId);
            return;
        }
        repository.save(new RecordingEntity(
                room, egressId, objectKey, sizeBytes, durationMs, startedAt, endedAt));
        outbox.ifAvailable(recorder -> recorder.record(
                "meeting.recording.completed", "room", room,
                Map.of("egressId", egressId, "location", objectKey, "sizeBytes", sizeBytes)));
        log.info("Recording stored for room {} ({}, {} bytes)", room, egressId, sizeBytes);
    }

    @Transactional(readOnly = true)
    public List<RecordingEntity> forRoom(String room) {
        return repository.findByRoomOrderByEndedAtDesc(room);
    }

    @Transactional(readOnly = true)
    public java.util.Optional<RecordingEntity> byId(long id) {
        return repository.findById(id);
    }
}
