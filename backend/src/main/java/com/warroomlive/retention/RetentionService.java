package com.warroomlive.retention;

import com.warroomlive.attachments.AttachmentEntity;
import com.warroomlive.attachments.AttachmentStore;
import com.warroomlive.recordings.RecordingEntity;
import com.warroomlive.recordings.RecordingStore;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Deletes data that has outlived its retention period.
 *
 * <p>Everything durable here grew without bound: recordings and their MP4s,
 * shared files and theirs, chat and its search projection, the audit trail,
 * published outbox rows. Only the
 * CRDT log compacts itself. For a meeting product that is not only a storage
 * bill — recordings and transcripts of people's meetings kept forever are a
 * privacy and compliance problem, and "we never delete anything" is not an
 * answer to a deletion request.
 *
 * <p><strong>Every period defaults to zero, meaning keep forever.</strong> A
 * retention job that started deleting the moment it was deployed would be a
 * terrible surprise; an operator opts in per data type, and the log says plainly
 * what was removed.
 *
 * <p>Chat and its search projection share one period on purpose. Deleting the
 * message but keeping the index would leave search returning text that no longer
 * exists anywhere else — a leak dressed as a feature.
 */
@Component
@Profile("postgres")
public class RetentionService {

    private static final Logger log = LoggerFactory.getLogger(RetentionService.class);

    /** Rows per statement, so one delete cannot hold locks for minutes. */
    private static final int BATCH = 500;
    /**
     * Batches per table per pass. A sweep drains what it reasonably can and
     * leaves the rest for the next hour rather than running unbounded — a first
     * enablement against years of history should not be one enormous transaction.
     */
    private static final int MAX_BATCHES = 20;

    private final EntityManager entityManager;
    private final RecordingStore recordings;
    private final AttachmentStore attachments;
    private final TransactionTemplate tx;
    private final MeterRegistry metrics;

    private final Duration recordingRetention;
    private final Duration chatRetention;
    private final Duration auditRetention;
    private final Duration publishedEventRetention;
    private final Duration attachmentRetention;

    public RetentionService(
            EntityManager entityManager,
            RecordingStore recordings,
            AttachmentStore attachments,
            TransactionTemplate tx,
            MeterRegistry metrics,
            @Value("${warroomlive.retention.recordings-days:0}") int recordingDays,
            @Value("${warroomlive.retention.chat-days:0}") int chatDays,
            @Value("${warroomlive.retention.audit-days:0}") int auditDays,
            @Value("${warroomlive.retention.published-events-days:0}") int publishedEventDays,
            @Value("${warroomlive.retention.attachments-days:0}") int attachmentDays) {
        this.entityManager = entityManager;
        this.recordings = recordings;
        this.attachments = attachments;
        this.tx = tx;
        this.metrics = metrics;
        this.recordingRetention = Duration.ofDays(recordingDays);
        this.chatRetention = Duration.ofDays(chatDays);
        this.auditRetention = Duration.ofDays(auditDays);
        this.publishedEventRetention = Duration.ofDays(publishedEventDays);
        this.attachmentRetention = Duration.ofDays(attachmentDays);
    }

    /**
     * Hourly is frequent enough for day-granularity periods and cheap enough to
     * be uninteresting. The first pass waits a minute after startup rather than
     * running immediately, so a crash loop cannot become a deletion loop.
     */
    @Scheduled(initialDelayString = "${warroomlive.retention.initial-delay-ms:60000}",
            fixedDelayString = "${warroomlive.retention.interval-ms:3600000}")
    public void sweep() {
        try {
            purgeRecordings();
            purgeAttachments();
            purgeChat();
            purgeAudit();
            purgePublishedEvents();
        } catch (Exception e) {
            // A failed sweep must not kill the schedule — the next hour retries,
            // and nothing here is time-critical enough to escalate further.
            log.warn("Retention sweep failed; will retry on the next pass", e);
        }
    }

    /** Recordings expire as a pair: the object, then the row that names it. */
    int purgeRecordings() {
        if (recordingRetention.isZero()) {
            return 0;
        }
        Instant cutoff = Instant.now().minus(recordingRetention);
        int removed = 0;
        for (int pass = 0; pass < MAX_BATCHES; pass++) {
            List<RecordingEntity> expired = recordings.expiredBefore(cutoff, BATCH);
            if (expired.isEmpty()) {
                break;
            }
            int deletedThisPass = 0;
            for (RecordingEntity recording : expired) {
                if (recordings.delete(recording, "retention", "system")) {
                    deletedThisPass++;
                } else {
                    log.warn("Keeping recording {} — its object could not be removed; will retry",
                            recording.getEgressId());
                }
            }
            removed += deletedThisPass;
            // Every candidate was skipped: the object store is unreachable, and
            // re-reading the same rows forever would achieve nothing.
            if (deletedThisPass == 0) {
                break;
            }
        }
        report("recordings", removed, recordingRetention);
        return removed;
    }

    /** Shared files expire the same way recordings do: object, then row. */
    int purgeAttachments() {
        if (attachmentRetention.isZero()) {
            return 0;
        }
        Instant cutoff = Instant.now().minus(attachmentRetention);
        int removed = 0;
        for (int pass = 0; pass < MAX_BATCHES; pass++) {
            List<AttachmentEntity> expired = attachments.expiredBefore(cutoff, BATCH);
            if (expired.isEmpty()) {
                break;
            }
            int deletedThisPass = 0;
            for (AttachmentEntity attachment : expired) {
                if (attachments.delete(attachment, "retention", "system")) {
                    deletedThisPass++;
                } else {
                    log.warn("Keeping file {} — its object could not be removed; will retry",
                            attachment.getObjectKey());
                }
            }
            removed += deletedThisPass;
            if (deletedThisPass == 0) {
                break;
            }
        }
        report("attachments", removed, attachmentRetention);
        return removed;
    }

    /**
     * Chat stores its timestamp as epoch millis, so the cutoff is compared as a
     * number rather than wrapped in {@code to_timestamp} — an expression around
     * the column would make the index on it unusable.
     */
    int purgeChat() {
        if (chatRetention.isZero()) {
            return 0;
        }
        long cutoff = Instant.now().minus(chatRetention).toEpochMilli();
        int removed = purge("chat_message", "ts < ?1", cutoff)
                + purge("message_search", "ts < ?1", cutoff);
        report("chat", removed, chatRetention);
        return removed;
    }

    int purgeAudit() {
        if (auditRetention.isZero()) {
            return 0;
        }
        int removed = purge("audit_log", "occurred_at < ?1", Instant.now().minus(auditRetention));
        report("audit", removed, auditRetention);
        return removed;
    }

    /** Only rows the publisher has already shipped are eligible; pending ones are the queue. */
    int purgePublishedEvents() {
        if (publishedEventRetention.isZero()) {
            return 0;
        }
        int removed = purge("outbox_events", "published_at IS NOT NULL AND published_at < ?1",
                Instant.now().minus(publishedEventRetention));
        report("published-events", removed, publishedEventRetention);
        return removed;
    }

    /**
     * Deletes matching rows in bounded batches, each its own transaction.
     *
     * <p>The tables belong to services that do not share an entity model (the
     * indexer owns two of them), so this is native SQL against the schema rather
     * than JPA. The {@code ctid IN (SELECT … LIMIT n)} shape is how PostgreSQL
     * expresses a limited delete, which it has no direct syntax for.
     */
    private int purge(String table, String predicate, Object cutoff) {
        String sql = "DELETE FROM " + table + " WHERE ctid IN ("
                + "SELECT ctid FROM " + table + " WHERE " + predicate + " LIMIT " + BATCH + ")";
        int total = 0;
        for (int pass = 0; pass < MAX_BATCHES; pass++) {
            Integer deleted = tx.execute(status -> entityManager.createNativeQuery(sql)
                    .setParameter(1, cutoff)
                    .executeUpdate());
            int n = deleted == null ? 0 : deleted;
            total += n;
            if (n < BATCH) {
                break;
            }
        }
        return total;
    }

    private void report(String kind, int removed, Duration retention) {
        if (removed > 0) {
            log.info("Retention removed {} {} row(s) older than {} day(s)",
                    removed, kind, retention.toDays());
            metrics.counter("warroomlive.retention.deleted", "kind", kind).increment(removed);
        }
    }
}
