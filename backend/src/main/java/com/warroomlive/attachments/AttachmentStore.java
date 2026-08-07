package com.warroomlive.attachments;

import com.warroomlive.events.OutboxRecorder;
import com.warroomlive.recordings.ObjectStore;
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
import java.util.Optional;

/**
 * Files shared into a room.
 *
 * <p>Present only under the {@code postgres} profile, like the other durable
 * stores — the default profile excludes the JPA auto-configuration entirely so
 * the application can run with no database at all.
 *
 * <p>Deletion mirrors recordings exactly, and for the same reason: the object
 * goes first, so a store that refuses leaves the row for the next attempt
 * rather than leaving a file nothing points at.
 */
@Component
@Profile("postgres")
public class AttachmentStore {

    private static final Logger log = LoggerFactory.getLogger(AttachmentStore.class);

    private final AttachmentJpaRepository repository;
    private final ObjectProvider<OutboxRecorder> outbox;
    private final ObjectStore objects;
    private final TransactionTemplate tx;

    public AttachmentStore(AttachmentJpaRepository repository, ObjectProvider<OutboxRecorder> outbox,
            ObjectStore objects, TransactionTemplate tx) {
        this.repository = repository;
        this.outbox = outbox;
        this.objects = objects;
        this.tx = tx;
    }

    /**
     * Records a file whose upload already succeeded.
     *
     * <p>Idempotent on the object key: a client that retries its confirmation
     * after a dropped response must not list the same file twice.
     */
    @Transactional
    public AttachmentEntity created(String room, String objectKey, String filename,
            String contentType, long sizeBytes, String uploadedBy) {
        Optional<AttachmentEntity> existing = repository.findByObjectKey(objectKey);
        if (existing.isPresent()) {
            return existing.get();
        }
        AttachmentEntity saved = repository.save(new AttachmentEntity(
                room, objectKey, filename, contentType, sizeBytes, uploadedBy));
        outbox.ifAvailable(recorder -> recorder.record(
                "attachment.created", "room", room,
                Map.of("attachmentId", saved.getId(), "filename", filename,
                        "sizeBytes", sizeBytes, "actor", uploadedBy)));
        log.info("File {} shared into room {} ({} bytes) by {}", filename, room, sizeBytes, uploadedBy);
        return saved;
    }

    @Transactional(readOnly = true)
    public List<AttachmentEntity> forRoom(String room, int limit, int offset) {
        return repository.pageForRoom(room, limit, offset);
    }

    @Transactional(readOnly = true)
    public Optional<AttachmentEntity> byId(long id) {
        return repository.findById(id);
    }

    @Transactional(readOnly = true)
    public List<AttachmentEntity> expiredBefore(Instant cutoff, int limit) {
        return repository.findByUploadedAtBeforeOrderByUploadedAtAsc(cutoff, Limit.of(limit));
    }

    /** Object first, then the row that names it. See {@code RecordingStore.delete}. */
    public boolean delete(AttachmentEntity attachment, String reason, String actor) {
        if (!objects.delete(attachment.getObjectKey())) {
            return false;
        }
        tx.executeWithoutResult(status -> {
            repository.deleteById(attachment.getId());
            outbox.ifAvailable(recorder -> recorder.record(
                    "attachment.deleted", "room", attachment.getRoom(),
                    Map.of("attachmentId", attachment.getId(),
                            "filename", attachment.getFilename(),
                            "reason", reason,
                            "actor", actor)));
        });
        log.info("File {} removed from room {} ({} by {})",
                attachment.getFilename(), attachment.getRoom(), reason, actor);
        return true;
    }
}
