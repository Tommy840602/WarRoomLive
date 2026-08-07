package com.warroomlive.recordings;

import com.warroomlive.events.OutboxRecorder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

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
    private final ObjectStore objects;
    private final TransactionTemplate tx;

    public RecordingStore(RecordingJpaRepository repository, ObjectProvider<OutboxRecorder> outbox,
            ObjectStore objects, TransactionTemplate tx) {
        this.repository = repository;
        this.outbox = outbox;
        this.objects = objects;
        this.tx = tx;
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
    public List<RecordingEntity> forRoom(String room, int limit, int offset) {
        return repository.pageForRoom(room, limit, offset);
    }

    @Transactional(readOnly = true)
    public java.util.Optional<RecordingEntity> byId(long id) {
        return repository.findById(id);
    }

    @Transactional(readOnly = true)
    public List<RecordingEntity> expiredBefore(Instant cutoff, int limit) {
        return repository.findByEndedAtBeforeOrderByEndedAtAsc(cutoff, Limit.of(limit));
    }

    /**
     * Removes a recording: the object first, then the row that names it.
     *
     * <p>That order is deliberate. If the object cannot be removed the row stays,
     * so the next attempt tries again; the reverse would leave an MP4 of someone's
     * meeting in the bucket with nothing left pointing at it — precisely the state
     * a deletion is meant to prevent.
     *
     * <p>The upload is not part of the transaction (it is an HTTP call to another
     * service and cannot be rolled back), but the row and its audit event are, so
     * no deletion is ever recorded without happening or happens unrecorded.
     *
     * @param reason why it was deleted — {@code retention} or {@code manual}
     * @param actor  who asked: an authenticated subject, or {@code system} for
     *               the retention sweep. Both go on the event, because "when was
     *               this deleted and by whom" is the question a deletion policy
     *               eventually has to answer.
     * @return true when the recording is gone
     */
    public boolean delete(RecordingEntity recording, String reason, String actor) {
        if (!objects.delete(recording.getObjectKey())) {
            return false;
        }
        tx.executeWithoutResult(status -> {
            repository.deleteById(recording.getId());
            outbox.ifAvailable(recorder -> recorder.record(
                    "meeting.recording.deleted", "room", recording.getRoom(),
                    Map.of("egressId", recording.getEgressId(),
                            "location", recording.getObjectKey(),
                            "reason", reason,
                            "actor", actor)));
        });
        log.info("Recording {} deleted from room {} ({} by {})",
                recording.getEgressId(), recording.getRoom(), reason, actor);
        return true;
    }
}
