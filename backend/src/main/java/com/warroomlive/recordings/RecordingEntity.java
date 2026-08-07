package com.warroomlive.recordings;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A finished recording of a room, as reported by LiveKit Egress once the upload
 * completed.
 *
 * <p>Only the object key is kept. Playback goes through a presigned URL minted
 * on request, so the object store's credentials never reach the browser and a
 * link cannot outlive the access it was granted.
 */
@Entity
@Table(name = "recordings")
public class RecordingEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    /** Egress job id; unique, so a redelivered webhook cannot duplicate the row. */
    @Column(name = "egress_id", nullable = false, unique = true)
    private String egressId;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(name = "duration_ms", nullable = false)
    private long durationMs;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "ended_at", nullable = false)
    private Instant endedAt;

    protected RecordingEntity() {
    }

    public RecordingEntity(String room, String egressId, String objectKey,
            long sizeBytes, long durationMs, Instant startedAt, Instant endedAt) {
        this.room = room;
        this.egressId = egressId;
        this.objectKey = objectKey;
        this.sizeBytes = sizeBytes;
        this.durationMs = durationMs;
        this.startedAt = startedAt;
        this.endedAt = endedAt == null ? Instant.now() : endedAt;
    }

    public Long getId() {
        return id;
    }

    public String getRoom() {
        return room;
    }

    public String getEgressId() {
        return egressId;
    }

    public String getObjectKey() {
        return objectKey;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getEndedAt() {
        return endedAt;
    }
}
